/**
 * Integration-test harness for the Books, Library, Stories and Author routes.
 *
 * The suites run against the development Postgres (`docker compose up
 * postgres`). Everything a suite creates is namespaced by a per-run prefix and
 * torn down afterwards, so a run leaves no residue and cannot disturb seeded
 * catalogue data.
 */

import { Temporal } from "temporal-polyfill";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import app from "../app.js";
import { db } from "../prisma/db.js";
import { deleteAll } from "../prisma/delete-all.js";
import { drainDeferredWrites } from "../services/deferred.js";
import { type NotificationType } from "../services/notifications.js";
import { deletePreferencesFor } from "../services/preferences.js";
import { DEV_USER_HEADER } from "../middleware/current-user.js";
import { slugify } from "../lib/slug.js";

export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

/** Nothing may sign in as a fixture user. */
const UNUSABLE_PASSWORD_HASH = "!test-fixture-no-login";

export class TestApi {
  private server: Server | undefined;
  /**
   * Where the test app is listening. Public so a test can fetch something the
   * `request` helper does not model — a stored upload's URL, say, which has to
   * be reached the way a browser would.
   */
  baseUrl = "";

  /** Every id this run created, so teardown removes exactly its own rows. */
  private readonly created = {
    entries: [] as string[],
    links: [] as { storyId: string; genreId: string }[],
    multimedia: [] as string[],
    chapters: [] as string[],
    stories: [] as string[],
    genres: [] as string[],
    clubs: [] as string[],
    channels: [] as string[],
    challenges: [] as string[],
    users: [] as string[],
  };

  /** Usernames by id, so a suite can address a fixture account by handle. */
  private readonly usernames = new Map<string, string>();

  readonly runId = `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  async start(): Promise<void> {
    this.server = app.listen(0);
    await new Promise<void>((resolve) => this.server?.once("listening", resolve));
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await this.cleanup();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /* Requests ------------------------------------------------------------ */

  async request<T = any>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      /** Omit to make the request anonymously. */
      as?: string;
      /** Sends bytes verbatim instead of JSON, for the avatar upload route. */
      raw?: { data: Buffer; contentType: string };
    } = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.raw) headers["Content-Type"] = options.raw.contentType;
    if (options.as) headers[DEV_USER_HEADER] = options.as;

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.raw
        ? new Uint8Array(options.raw.data)
        : options.body === undefined
          ? undefined
          : JSON.stringify(options.body),
    });

    return {
      status: response.status,
      body: response.status === 204 ? (null as T) : ((await response.json()) as T),
    };
  }

  /* Fixtures ------------------------------------------------------------- */

  /**
   * A fixture account. The optional profile fields exist for the public
   * profile suite, which has to assert that a display name and a bio come
   * back and that an email never does.
   */
  async createUser(
    label: string,
    profile: {
      displayName?: string;
      bio?: string;
      isAuthor?: boolean;
    } = {},
  ): Promise<string> {
    const username = `${this.runId}-${label}`.slice(0, 30);
    const user = await db.orm.auth.User.select("id").create({
      username,
      email: `${username}@fixtures.invalid`,
      passwordHash: UNUSABLE_PASSWORD_HASH,
      displayName: profile.displayName ?? null,
      bio: profile.bio ?? null,
      isAuthor: profile.isAuthor ?? false,
    });

    this.created.users.push(user.id);
    this.usernames.set(user.id, username);
    return user.id;
  }

  /**
   * Settles the fire-and-forget writes a request leaves behind.
   *
   * A `GET .../chapters/1` returns before its view and read events have
   * inserted, and a comment returns before its badge evaluation has. A test
   * that asserts on those rows -- or that performs something they would
   * breach a foreign key against, which is what account deletion is -- has to
   * wait for them, and `cleanup` already drains the same three at teardown.
   *
   * The order the three settle in is `drainDeferredWrites`'s business.
   */
  async settleBackgroundWrites(): Promise<void> {
    await drainDeferredWrites();
  }

  /**
   * The username `createUser` minted for a fixture account.
   *
   * Public profiles are addressed by handle, not by id, so a suite holding
   * only the id cannot build the URL without this -- and recomputing the
   * `runId` prefix in the test would duplicate the truncation rule above.
   */
  usernameOf(userId: string): string {
    const username = this.usernames.get(userId);
    if (!username) throw new Error(`no such fixture user: ${userId}`);

    return username;
  }

  async createGenre(name: string, hue = 200): Promise<string> {
    const genre = await db.orm.content.Genre.select("id").create({
      name: `${this.runId}-${name}`,
      hue,
    });

    this.created.genres.push(genre.id);
    return genre.id;
  }

  async createBook(input: {
    title: string;
    authorId: string;
    genreIds?: string[];
    isbn?: string;
    publisher?: string;
    publishedAt?: string;
    pageCount?: number;
    ratingAverage?: number | null;
    viewCount?: number;
    likeCount?: number;
    isCompleted?: boolean;
    kidsAppropriate?: boolean;
    description?: string;
  }): Promise<string> {
    const story = await db.orm.content.Story.select("id").create({
      authorId: input.authorId,
      title: input.title,
      description: input.description ?? `${input.title} — fixture`,
      // Unique per run, and never a slugified title: a fixture must not be
      // able to collide with a seeded story's slug.
      slug: `${this.runId}-${slugify(input.title)}`.slice(0, 80),
      source: "CATALOGUE",
      // Catalogue imports are readable the moment they land.
      listedAt: Temporal.Now.instant(),
      isbn: input.isbn ?? `${this.runId}-${input.title}`.slice(0, 40),
      publisher: input.publisher ?? "Fixture Press",
      publishedAt: Temporal.Instant.from(
        `${input.publishedAt ?? "2024-01-01"}T00:00:00Z`,
      ),
      pageCount: input.pageCount ?? 200,
      ratingAverage:
        input.ratingAverage === null ? null : String(input.ratingAverage ?? 4),
      viewCount: input.viewCount ?? 0,
      likeCount: input.likeCount ?? 0,
      isCompleted: input.isCompleted ?? true,
      kidsAppropriate: input.kidsAppropriate ?? false,
    });

    this.created.stories.push(story.id);

    for (const genreId of input.genreIds ?? []) {
      await db.orm.content.StoryGenre.create({ storyId: story.id, genreId });
      this.created.links.push({ storyId: story.id, genreId });
    }

    return story.id;
  }

  /**
   * An authored story -- `source = SCRIBE`, addressed by slug, chaptered.
   *
   * Listed by default; pass `listed: false` for a draft, which only its author
   * may see.
   */
  async createStory(input: {
    title: string;
    authorId: string;
    genreIds?: string[];
    slug?: string;
    listed?: boolean;
    isCompleted?: boolean;
    ratingAverage?: number | null;
    viewCount?: number;
    likeCount?: number;
    kidsAppropriate?: boolean;
    description?: string;
  }): Promise<{ id: string; slug: string }> {
    const slug = `${this.runId}-${input.slug ?? slugify(input.title)}`.slice(0, 80);

    const story = await db.orm.content.Story.select("id").create({
      authorId: input.authorId,
      title: input.title,
      description: input.description ?? `${input.title} — fixture`,
      slug,
      source: "SCRIBE",
      listedAt: input.listed === false ? null : Temporal.Now.instant(),
      isCompleted: input.isCompleted ?? false,
      ratingAverage:
        input.ratingAverage === null ? null : String(input.ratingAverage ?? 4),
      viewCount: input.viewCount ?? 0,
      likeCount: input.likeCount ?? 0,
      kidsAppropriate: input.kidsAppropriate ?? false,
    });

    this.created.stories.push(story.id);

    for (const genreId of input.genreIds ?? []) {
      await db.orm.content.StoryGenre.create({ storyId: story.id, genreId });
      this.created.links.push({ storyId: story.id, genreId });
    }

    return { id: story.id, slug };
  }

  /** A chapter of an authored story. Published unless told otherwise. */
  async createChapter(input: {
    storyId: string;
    number: number;
    title?: string;
    content?: string;
    wordCount?: number;
    published?: boolean;
  }): Promise<string> {
    const content = input.content ?? `Body of chapter ${input.number}.`;

    const chapter = await db.orm.content.Chapter.select("id").create({
      storyId: input.storyId,
      chapterNumber: input.number,
      title: input.title ?? `Chapter ${input.number}`,
      content,
      wordCount: input.wordCount ?? content.trim().split(/\s+/).length,
      publishedAt:
        input.published === false ? null : Temporal.Now.instant(),
    });

    this.created.chapters.push(chapter.id);
    return chapter.id;
  }

  /** A media attachment on a chapter. */
  async createMultimedia(input: {
    chapterId: string;
    type?: "IMAGE" | "AUDIO" | "VIDEO" | "LINK";
    url?: string;
    displayOrder?: number;
  }): Promise<string> {
    const item = await db.orm.content.Multimedia.select("id").create({
      chapterId: input.chapterId,
      type: input.type ?? "IMAGE",
      url: input.url ?? "https://example.invalid/fixture.png",
      displayOrder: input.displayOrder ?? 0,
    });

    this.created.multimedia.push(item.id);
    return item.id;
  }

  /** Records a shelf row this run caused, so teardown can remove it. */
  track(entryId: string): void {
    this.created.entries.push(entryId);
  }

  /**
   * Records a club or channel a suite created *through the API*, so teardown
   * reaches it. Rows created by the fixtures below are tracked already; these
   * are for the ids a `POST` handed back.
   */
  trackClub(clubId: string): void {
    if (!this.created.clubs.includes(clubId)) this.created.clubs.push(clubId);
  }

  trackChannel(channelId: string): void {
    if (!this.created.channels.includes(channelId)) {
      this.created.channels.push(channelId);
    }
  }

  trackChallenge(challengeId: string): void {
    if (!this.created.challenges.includes(challengeId)) {
      this.created.challenges.push(challengeId);
    }
  }

  /* Clubs ---------------------------------------------------------------- */

  /**
   * A club with its creator already holding `OWNER` -- the state
   * `createClub` in the service leaves behind, which every authorisation path
   * assumes.
   */
  async createClub(input: {
    name: string;
    creatorId: string;
    slug?: string;
    currentStoryId?: string | null;
  }): Promise<{ id: string; slug: string }> {
    const slug = `${this.runId}-${input.slug ?? slugify(input.name)}`.slice(0, 80);

    const club = await db.orm.clubs.BookClub.select("id").create({
      name: input.name,
      slug,
      description: `${input.name} — fixture`,
      creatorId: input.creatorId,
      currentStoryId: input.currentStoryId ?? null,
    });

    this.created.clubs.push(club.id);

    await db.orm.clubs.ClubMembership.create({
      clubId: club.id,
      userId: input.creatorId,
      role: "OWNER",
    });

    return { id: club.id, slug };
  }

  /** Puts somebody in a club at a chosen role. */
  async addClubMember(input: {
    clubId: string;
    userId: string;
    role?: "OWNER" | "ADMIN" | "MEMBER";
  }): Promise<void> {
    await db.orm.clubs.ClubMembership.create({
      clubId: input.clubId,
      userId: input.userId,
      role: input.role ?? "MEMBER",
    });
  }

  /** A thread, or a reply when `parentId` is given. */
  async createDiscussion(input: {
    clubId: string;
    userId: string;
    body?: string;
    parentId?: string | null;
  }): Promise<string> {
    const row = await db.orm.clubs.ClubDiscussion.select("id").create({
      clubId: input.clubId,
      userId: input.userId,
      body: input.body ?? "Fixture discussion.",
      parentId: input.parentId ?? null,
    });

    return row.id;
  }

  /* Challenges ----------------------------------------------------------- */

  /**
   * A writing challenge whose window is given in days from now.
   *
   * Relative rather than absolute, because every rule worth testing is about
   * where `now()` falls: `{ opensIn: 2 }` is upcoming, `{ opensIn: -1,
   * closesIn: 1 }` is active, and `{ closesIn: -1 }` is past. A suite cannot
   * wait a day and must not move the clock, which the database's own `now()`
   * would not follow.
   */
  async createChallenge(input: {
    title: string;
    hostId: string;
    /** Days from now the window opens. Negative is in the past. */
    opensIn?: number;
    /** Days from now the window closes. */
    closesIn?: number;
    slug?: string;
    prompt?: string;
    wordTarget?: number | null;
  }): Promise<{ id: string; slug: string }> {
    const slug = `${this.runId}-${input.slug ?? slugify(input.title)}`.slice(0, 80);
    const day = 24 * 60 * 60 * 1000;

    const challenge = await db.orm.challenges.WritingChallenge.select("id").create({
      title: input.title,
      slug,
      prompt: input.prompt ?? "Write something about a door.",
      description: `${input.title} — fixture`,
      wordTarget: input.wordTarget === undefined ? 1000 : input.wordTarget,
      hostId: input.hostId,
      startAt: Temporal.Instant.from(
        new Date(Date.now() + (input.opensIn ?? -1) * day).toISOString(),
      ),
      endAt: Temporal.Instant.from(
        new Date(Date.now() + (input.closesIn ?? 7) * day).toISOString(),
      ),
    });

    this.created.challenges.push(challenge.id);
    return { id: challenge.id, slug };
  }

  /** A place in a challenge, with a story on it when one is given. */
  async createChallengeEntry(input: {
    challengeId: string;
    userId: string;
    storyId?: string | null;
    note?: string | null;
    submittedAt?: Date;
  }): Promise<string> {
    const entry = await db.orm.challenges.ChallengeEntry.select("id").create({
      challengeId: input.challengeId,
      userId: input.userId,
      storyId: input.storyId ?? null,
      note: input.note ?? null,
      ...(input.submittedAt
        ? { submittedAt: Temporal.Instant.from(input.submittedAt.toISOString()) }
        : {}),
    });

    return entry.id;
  }

  /* Preferences ---------------------------------------------------------- */

  /**
   * Preferences written straight to the tables rather than through `PUT
   * /api/account/preferences`.
   *
   * A recommendation suite spends most of its setup describing a reader's
   * taste, and routing every one of those through the endpoint would test the
   * endpoint a hundred times and the ranking once. The suite that covers the
   * endpoint uses the endpoint.
   */
  async setPreferences(
    userId: string,
    input: {
      genreIds?: string[];
      contentLength?: "SHORT" | "MEDIUM" | "LONG" | "ANY";
      mutedNotificationTypes?: NotificationType[];
      onboardingComplete?: boolean;
    },
  ): Promise<void> {
    const completedAt =
      input.onboardingComplete === true ? Temporal.Now.instant() : null;

    const existing = await db.orm.auth.UserPreference.select("userId")
      .where((row) => row.userId.eq(userId))
      .first();

    if (existing) {
      await db.orm.auth.UserPreference.where((row) => row.userId.eq(userId)).update({
        contentLength: input.contentLength ?? "ANY",
        onboardingCompletedAt: completedAt,
        updatedAt: Temporal.Now.instant(),
      });
    } else {
      await db.orm.auth.UserPreference.create({
        userId,
        contentLength: input.contentLength ?? "ANY",
        onboardingCompletedAt: completedAt,
      });
    }

    if (input.genreIds) {
      await deleteAll(() =>
        db.orm.auth.GenrePreference.where((row) => row.userId.eq(userId)),
      );
      for (const genreId of input.genreIds) {
        await db.orm.auth.GenrePreference.create({ userId, genreId });
      }
    }

    if (input.mutedNotificationTypes) {
      await deleteAll(() =>
        db.orm.auth.NotificationMute.where((row) => row.userId.eq(userId)),
      );
      for (const type of input.mutedNotificationTypes) {
        await db.orm.auth.NotificationMute.create({ userId, type });
      }
    }
  }

  /** Makes a fixture account an administrator, which no endpoint can do. */
  async setAdmin(userId: string, isAdmin = true): Promise<void> {
    await db.orm.auth.User.where((user) => user.id.eq(userId)).update({ isAdmin });
  }

  /* Moderation ----------------------------------------------------------- */

  /**
   * Whether a fixture account is suspended, for asserting what a resolve did.
   *
   * Read straight from the column rather than inferred from a refused write:
   * a test that proved suspension only by watching a comment 403 could not
   * tell a suspension from any other reason the post was refused.
   */
  async readSuspended(userId: string): Promise<boolean> {
    const user = await db.orm.auth.User.select("suspendedAt")
      .where((row) => row.id.eq(userId))
      .first();

    if (!user) throw new Error(`no such fixture user: ${userId}`);

    return user.suspendedAt !== null && user.suspendedAt !== undefined;
  }

  /** Suspends a fixture account directly, for testing what a suspension stops. */
  async setSuspended(userId: string, suspended = true): Promise<void> {
    await db.orm.auth.User.where((user) => user.id.eq(userId)).update({
      suspendedAt: suspended ? Temporal.Now.instant() : null,
    });
  }

  /**
   * How many notifications quote one piece of content.
   *
   * The only way to see the sweep that hiding performs: the copies live in
   * other people's lists, so no endpoint the test can call as one reader
   * answers "are they gone for everybody?".
   */
  async countNotificationsFor(
    sourceType: "COMMENT" | "CLUB_DISCUSSION" | "CHANNEL_POST",
    sourceId: string,
  ): Promise<number> {
    const totals = await db.orm.notifications.Notification.where((row) =>
      row.sourceType.eq(sourceType),
    )
      .where((row) => row.sourceId.eq(sourceId))
      .aggregate((aggregate) => ({ total: aggregate.count() }));

    return totals.total;
  }

  /**
   * Moves one account's notifications back in time.
   *
   * The only way to test retention without waiting a week. It rewrites
   * `createdAt` and, where the row has one, `readAt` -- both, because the two
   * ceilings in `services/notifications.ts` read different columns and a
   * helper that shifted one of them could only ever exercise half the rule.
   *
   * Raw SQL rather than the ORM for `markAllRead`'s reason: `update` writes one
   * row per call, and this is meant to move a whole list at once.
   */
  async backdateNotifications(userId: string, days: number): Promise<void> {
    const plan = db.raw.sql`
      UPDATE "notifications"."notification"
         SET "createdAt" = "createdAt" - make_interval(days => ${days}::int),
             "readAt" = CASE
               WHEN "readAt" IS NULL THEN NULL
               ELSE "readAt" - make_interval(days => ${days}::int)
             END
       WHERE "userId" = ${userId}
    `.affectedCount().build();

    await db.runtime().query(plan);
  }

  /** How many notification rows one account holds, read or not. */
  async countNotifications(userId: string): Promise<number> {
    const totals = await db.orm.notifications.Notification.where((row) =>
      row.userId.eq(userId),
    ).aggregate((aggregate) => ({ total: aggregate.count() }));

    return totals.total;
  }

  /* Channels ------------------------------------------------------------- */

  async createChannel(input: {
    name: string;
    authorId: string;
    slug?: string;
  }): Promise<{ id: string; slug: string }> {
    const slug = `${this.runId}-${input.slug ?? slugify(input.name)}`.slice(0, 80);

    const channel = await db.orm.channels.BroadcastChannel.select("id").create({
      authorId: input.authorId,
      name: input.name,
      slug,
      description: `${input.name} — fixture`,
    });

    this.created.channels.push(channel.id);
    return { id: channel.id, slug };
  }

  /**
   * A post on a channel. `postedAt` is settable because the feed's ordering
   * and pagination cannot be exercised against rows written in the same
   * millisecond.
   */
  async createChannelPost(input: {
    channelId: string;
    title?: string;
    content?: string;
    postedAt?: Date;
  }): Promise<string> {
    const post = await db.orm.channels.ChannelPost.select("id").create({
      channelId: input.channelId,
      title: input.title ?? "Fixture post",
      content: input.content ?? "Body of a fixture post.",
      ...(input.postedAt
        ? { postedAt: Temporal.Instant.from(input.postedAt.toISOString()) }
        : {}),
    });

    return post.id;
  }

  async subscribeToChannel(input: {
    channelId: string;
    userId: string;
  }): Promise<void> {
    await db.orm.channels.ChannelSubscriber.create({
      channelId: input.channelId,
      userId: input.userId,
    });
  }

  /** A comment on a story, or a reply to one when `parentId` is given. */
  async createComment(input: {
    storyId: string;
    userId: string;
    content?: string;
    chapterId?: string | null;
    parentId?: string | null;
  }): Promise<string> {
    const row = await db.orm.engagement.Comment.select("id").create({
      storyId: input.storyId,
      userId: input.userId,
      content: input.content ?? "Fixture comment.",
      chapterId: input.chapterId ?? null,
      parentId: input.parentId ?? null,
    });

    return row.id;
  }

  /**
   * One reader following another.
   *
   * Not tracked in `created`: a follow has no identity of its own worth
   * recording, and the per-user sweep in `cleanup` reaches every row this run
   * can produce -- including the ones a suite made through `POST
   * /api/users/:username/follow`, which no fixture ever saw.
   */
  async createFollow(input: {
    followerId: string;
    followingId: string;
  }): Promise<void> {
    await db.orm.engagement.Follow.create({
      followerId: input.followerId,
      followingId: input.followingId,
    });
  }

  /** How many followers a fixture user has, for asserting what a write did. */
  async countFollowers(userId: string): Promise<number> {
    const totals = await db.orm.engagement.Follow.where((row) =>
      row.followingId.eq(userId),
    ).aggregate((aggregate) => ({ total: aggregate.count() }));

    return totals.total;
  }

  /** A reader's rating of a story, for the aggregate paths. */
  async createRating(input: {
    userId: string;
    storyId: string;
    rating: number;
  }): Promise<void> {
    await db.orm.engagement.Rating.create({
      userId: input.userId,
      storyId: input.storyId,
      rating: String(input.rating),
    });
  }

  /**
   * A story's denormalised rating columns as stored, for asserting that a
   * rating write kept them in step with the `Rating` rows behind them.
   */
  async readStoryRating(
    storyId: string,
  ): Promise<{ average: number | null; count: number }> {
    const story = await db.orm.content.Story.select(
      "ratingAverage",
      "ratingCount",
    )
      .where((row) => row.id.eq(storyId))
      .first();

    if (!story) throw new Error(`no such fixture story: ${storyId}`);

    return {
      average:
        story.ratingAverage === null || story.ratingAverage === undefined
          ? null
          : Number(story.ratingAverage),
      count: story.ratingCount,
    };
  }

  /* Analytics ------------------------------------------------------------ */

  /**
   * A view or a chapter-read event on a chosen day.
   *
   * `daysAgo` is counted in SQL off the database's own UTC date, exactly as
   * `services/analytics.ts` computes a window's bounds -- a test cannot wait a
   * day, and computing the day here in Node would let the fixture and the
   * service disagree about which day "six days ago" is at the wrong moment.
   *
   * `visitorKey` defaults to the reader's own, which is what the service
   * writes for a signed-in caller; pass one explicitly to model two different
   * signed-out visitors, or the same one twice to exercise the dedupe.
   *
   * Returns whether a row was actually written, so a suite can assert that a
   * second identical event was swallowed by the unique key.
   */
  async recordEvent(input: {
    storyId: string;
    /** Set for a chapter read; omitted for a story view. */
    chapterId?: string;
    userId?: string | null;
    visitorKey?: string;
    daysAgo?: number;
  }): Promise<boolean> {
    const userId = input.userId ?? null;
    const key = input.visitorKey ?? (userId ? `user:${userId}` : "anon:fixture");
    const daysAgo = input.daysAgo ?? 0;

    const plan = input.chapterId
      ? db.raw.sql`
          INSERT INTO "engagement"."chapterRead"
            ("id", "storyId", "chapterId", "userId", "visitorKey", "day", "createdAt")
          VALUES (gen_random_uuid()::text, ${input.storyId}, ${input.chapterId},
                  NULLIF(${userId ?? ""}::text, ''), ${key},
                  to_char((now() AT TIME ZONE 'UTC')::date - ${daysAgo}::int,
                          'YYYY-MM-DD'),
                  now())
          ON CONFLICT ("chapterId", "visitorKey", "day") DO NOTHING
          RETURNING "id"
        `.returnsRow({ id: "pg/text@1" }).build()
      : db.raw.sql`
          INSERT INTO "engagement"."storyView"
            ("id", "storyId", "userId", "visitorKey", "day", "createdAt")
          VALUES (gen_random_uuid()::text, ${input.storyId},
                  NULLIF(${userId ?? ""}::text, ''), ${key},
                  to_char((now() AT TIME ZONE 'UTC')::date - ${daysAgo}::int,
                          'YYYY-MM-DD'),
                  now())
          ON CONFLICT ("storyId", "visitorKey", "day") DO NOTHING
          RETURNING "id"
        `.returnsRow({ id: "pg/text@1" }).build();

    // `ON CONFLICT DO NOTHING` returns a row for an insert and none for a
    // conflict, so "did the unique key swallow it?" is readable without a
    // second query. `.affectedCount()` looks like it would answer the same
    // thing and does not -- it comes back empty for this statement.
    const [row] = await db.runtime().query(plan);
    return row !== undefined;
  }

  /** How many view events a story carries, for asserting what a read did. */
  async countStoryViews(storyId: string): Promise<number> {
    const totals = await db.orm.engagement.StoryView.where((row) =>
      row.storyId.eq(storyId),
    ).aggregate((aggregate) => ({ total: aggregate.count() }));

    return totals.total;
  }

  /** The same for chapter reads, scoped to one chapter. */
  async countChapterReads(chapterId: string): Promise<number> {
    const totals = await db.orm.engagement.ChapterRead.where((row) =>
      row.chapterId.eq(chapterId),
    ).aggregate((aggregate) => ({ total: aggregate.count() }));

    return totals.total;
  }

  /** A story's lifetime view counter as stored. */
  async readViewCount(storyId: string): Promise<number> {
    const story = await db.orm.content.Story.select("viewCount")
      .where((row) => row.id.eq(storyId))
      .first();

    if (!story) throw new Error(`no such fixture story: ${storyId}`);

    return story.viewCount;
  }

  /**
   * Puts a reader's streak into a chosen state.
   *
   * Backdating the anchor is the only way to exercise the day-boundary
   * branches through the API: a test cannot wait a day, and moving the clock
   * would move it for the database's `now()` too, which the streak is compared
   * against.
   */
  async setStreak(
    userId: string,
    input: { streak: number; lastReadAt: Date | null },
  ): Promise<void> {
    await db.orm.auth.User.where((user) => user.id.eq(userId)).update({
      readingStreak: input.streak,
      streakLastReadAt:
        input.lastReadAt === null
          ? null
          : Temporal.Instant.from(input.lastReadAt.toISOString()),
    });
  }

  /**
   * Rewinds what a reader has been *told* their levels are.
   *
   * The cheap way to provoke a level-up: climbing a ladder for real costs ten
   * distinct chapter reads or a thousand written words, and neither of those
   * is what a test of "announced once" is about. Setting the announced level
   * below the derived one puts the account in exactly the state a reader who
   * just crossed a threshold is in.
   */
  async setAnnouncedLevels(
    userId: string,
    input: { reader: number; author: number },
  ): Promise<void> {
    await db.orm.auth.User.where((user) => user.id.eq(userId)).update({
      announcedReaderLevel: input.reader,
      announcedAuthorLevel: input.author,
    });
  }

  /** Backdates a high-water mark, for asserting it is never lowered. */
  async setLongestStreak(userId: string, longest: number): Promise<void> {
    await db.orm.auth.User.where((user) => user.id.eq(userId)).update({
      longestStreak: longest,
    });
  }

  /** A reader's streak as stored, for asserting what a write did. */
  async readStreak(
    userId: string,
  ): Promise<{ streak: number; longest: number; lastReadAt: Date | null }> {
    const user = await db.orm.auth.User.select(
      "readingStreak",
      "streakLastReadAt",
      "longestStreak",
    )
      .where((row) => row.id.eq(userId))
      .first();

    if (!user) throw new Error(`no such fixture user: ${userId}`);

    return {
      streak: user.readingStreak,
      longest: user.longestStreak,
      lastReadAt:
        user.streakLastReadAt === null || user.streakLastReadAt === undefined
          ? null
          : new Date(String(user.streakLastReadAt)),
    };
  }

  /* Badges ---------------------------------------------------------------- */

  /**
   * The badge codes a fixture account holds.
   *
   * Read straight from the table rather than through `GET /api/badges`,
   * because that endpoint evaluates before it answers -- a suite asserting
   * what an *event* awarded has to be able to look without awarding.
   */
  async readBadges(userId: string): Promise<string[]> {
    const rows = await db.orm.gamification.UserBadge.select("code")
      .where((row) => row.userId.eq(userId))
      .all();

    return rows.map((row) => row.code).sort();
  }

  /** The stored reader and author levels, for asserting a derivation. */
  async readLevels(
    userId: string,
  ): Promise<{ reader: number; author: number }> {
    const user = await db.orm.auth.User.select("readerLevel", "authorLevel")
      .where((row) => row.id.eq(userId))
      .first();

    if (!user) throw new Error(`no such fixture user: ${userId}`);

    return { reader: user.readerLevel, author: user.authorLevel };
  }

  /* Teardown -------------------------------------------------------------- */

  private async cleanup(): Promise<void> {
    /**
     * Fire-and-forget writes first, because they outlive the request that
     * issued them. A `PUT /api/reading/progress` returns before its badge
     * evaluation has inserted, and an insert landing *between* the badge sweep
     * below and the user delete at the end breaches
     * `userBadge_userId_fkey` -- a teardown failure with nothing in the test
     * body to explain it. The same is true of an analytics event and
     * `storyView_userId_fkey`, and of a notification fan-out and
     * `notification_userId_fkey`.
     */
    await drainDeferredWrites();

    /**
     * Rows a suite created *through the API* -- an authored story, its
     * chapters, an attachment -- carry no fixture id, so tracking alone would
     * leave them behind and the story delete below would then fail on a
     * foreign key. Everything authored by a fixture user is swept up instead;
     * the usernames are unique per run, so this can only reach this run's own
     * rows.
     */
    for (const userId of this.created.users) {
      const authored = await db.orm.content.Story.select("id")
        .where((story) => story.authorId.eq(userId))
        .all();

      for (const story of authored) {
        if (!this.created.stories.includes(story.id)) {
          this.created.stories.push(story.id);
        }
      }
    }

    /**
     * Clubs and channels a fixture user created through the API, swept up the
     * same way as their stories: a `POST /api/clubs` hands back an id the
     * suite may not have tracked, and the user delete at the end would then
     * fail on the foreign key.
     */
    for (const userId of this.created.users) {
      const clubs = await db.orm.clubs.BookClub.select("id")
        .where((club) => club.creatorId.eq(userId))
        .all();
      for (const club of clubs) this.trackClub(club.id);

      const channels = await db.orm.channels.BroadcastChannel.select("id")
        .where((channel) => channel.authorId.eq(userId))
        .all();
      for (const channel of channels) this.trackChannel(channel.id);

      const challenges = await db.orm.challenges.WritingChallenge.select("id")
        .where((challenge) => challenge.hostId.eq(userId))
        .all();
      for (const challenge of challenges) this.trackChallenge(challenge.id);
    }

    /**
     * Clubs go before the stories below, not after: `BookClub.currentStoryId`
     * references `content.Story`, so a club still pointing at a fixture story
     * would block that story's delete.
     */
    for (const clubId of this.created.clubs) {
      // Replies before threads: `parentId` points into this same table.
      await deleteAll(() =>
        db.orm.clubs.ClubDiscussion.where((row) => row.clubId.eq(clubId)).where(
          (row) => row.parentId.isNotNull(),
        ),
      );
      await deleteAll(() =>
        db.orm.clubs.ClubDiscussion.where((row) => row.clubId.eq(clubId)),
      );
      await deleteAll(() =>
        db.orm.clubs.ClubMembership.where((row) => row.clubId.eq(clubId)),
      );

      await db.orm.clubs.BookClub.where((club) => club.id.eq(clubId)).delete();
    }

    for (const channelId of this.created.channels) {
      await deleteAll(() =>
        db.orm.channels.ChannelPost.where((row) => row.channelId.eq(channelId)),
      );
      await deleteAll(() =>
        db.orm.channels.ChannelSubscriber.where((row) =>
          row.channelId.eq(channelId),
        ),
      );

      await db.orm.channels.BroadcastChannel.where((channel) =>
        channel.id.eq(channelId),
      ).delete();
    }

    /**
     * Challenges go before the stories below for the reason clubs do:
     * `ChallengeEntry.storyId` references `content.Story`, so an entry still
     * pointing at a fixture story would block that story's delete. The
     * per-user sweep catches a fixture reader's place in a *seeded* challenge,
     * which the per-challenge loop never visits.
     */
    for (const userId of this.created.users) {
      await deleteAll(() =>
        db.orm.challenges.ChallengeEntry.where((row) => row.userId.eq(userId)),
      );
    }

    for (const challengeId of this.created.challenges) {
      await deleteAll(() =>
        db.orm.challenges.ChallengeEntry.where((row) =>
          row.challengeId.eq(challengeId),
        ),
      );

      await db.orm.challenges.WritingChallenge.where((challenge) =>
        challenge.id.eq(challengeId),
      ).delete();
    }

    /**
     * Memberships, discussions and subscriptions a fixture user holds in rows
     * this run did *not* create -- a seeded club, say -- which the per-club
     * sweep above never visits.
     */
    for (const userId of this.created.users) {
      await deleteAll(() =>
        db.orm.clubs.ClubDiscussion.where((row) => row.userId.eq(userId)).where(
          (row) => row.parentId.isNotNull(),
        ),
      );
      await deleteAll(() =>
        db.orm.clubs.ClubDiscussion.where((row) => row.userId.eq(userId)),
      );
      await deleteAll(() =>
        db.orm.clubs.ClubMembership.where((row) => row.userId.eq(userId)),
      );
      await deleteAll(() =>
        db.orm.channels.ChannelSubscriber.where((row) => row.userId.eq(userId)),
      );
    }

    /**
     * Both ends of `moderation.Report`, before the user delete at the end.
     * Deleted rather than detached, unlike `deleteAccount`: a test run leaves
     * no record worth keeping, and a resolved report whose moderator is a
     * fixture would otherwise outlive the run holding a dangling target id.
     */
    for (const userId of this.created.users) {
      await deleteAll(() =>
        db.orm.moderation.Report.where((row) => row.reporterId.eq(userId)),
      );
      await deleteAll(() =>
        db.orm.moderation.Report.where((row) => row.resolvedById.eq(userId)),
      );
    }

    /**
     * Both ends of the follow graph. Swept by user rather than by tracked id:
     * a fixture user can follow, or be followed by, a *seeded* account, and
     * only one of the two columns names a row this run created.
     */
    for (const userId of this.created.users) {
      await deleteAll(() =>
        db.orm.engagement.Follow.where((row) => row.followerId.eq(userId)),
      );
      await deleteAll(() =>
        db.orm.engagement.Follow.where((row) => row.followingId.eq(userId)),
      );
    }

    // Shelf and reading-position rows first: they reference both users and
    // stories, and a suite can have written either against a *seeded* story,
    // which the per-story sweep below never visits.
    for (const userId of this.created.users) {
      await deleteAll(() =>
        db.orm.library.LibraryEntry.where((entry) => entry.userId.eq(userId)),
      );
      await deleteAll(() =>
        db.orm.engagement.ReadingHistory.where((row) => row.userId.eq(userId)),
      );
      await deleteAll(() =>
        db.orm.engagement.Rating.where((row) => row.userId.eq(userId)),
      );
      await deleteAll(() =>
        db.orm.engagement.StoryView.where((row) => row.userId.eq(userId)),
      );
      await deleteAll(() =>
        db.orm.engagement.ChapterRead.where((row) => row.userId.eq(userId)),
      );
      /**
       * Likes this fixture gave, which can sit on a *seeded* story's chapter
       * or comment -- rows the per-story sweep below never visits, and which
       * breach `chapterLike_userId_fkey` / `commentLike_userId_fkey` at the
       * user delete at the end.
       */
      await deleteAll(() =>
        db.orm.engagement.ChapterLike.where((row) => row.userId.eq(userId)),
      );
      await deleteAll(() =>
        db.orm.engagement.CommentLike.where((row) => row.userId.eq(userId)),
      );
      await deleteAll(() =>
        db.orm.gamification.UserBadge.where((row) => row.userId.eq(userId)),
      );
      // The three preference tables. `GenrePreference` also references
      // `content.Genre`, so these have to go before the genre sweep below as
      // well as before the user delete at the end.
      await deletePreferencesFor(db, userId);
      /**
       * Both sides of the notification table: the rows addressed to this
       * fixture and the rows its actions put in somebody else's list. Only the
       * first is obvious, and it is the second -- a reply notifying a seeded
       * user, say -- that breaches `notification_actorId_fkey` at the user
       * delete below.
       */
      await deleteAll(() =>
        db.orm.notifications.Notification.where((row) => row.userId.eq(userId)),
      );
      await deleteAll(() =>
        db.orm.notifications.Notification.where((row) =>
          row.actorId.eq(userId),
        ),
      );
    }

    /**
     * Comments a fixture user left on a *seeded* story, which the per-story
     * sweep below never visits.
     *
     * Two passes over the whole set of users rather than replies-then-threads
     * per user: one reader's reply routinely hangs off another's thread, so
     * finishing one user at a time deletes a thread whose reply is still
     * pointing at it and breaches `comment_parentId_fkey`.
     */
    /**
     * Likes *on* those comments, whoever left them -- a suite routinely has
     * one fixture like another's comment, and the per-user sweep above only
     * cleared the likes each fixture gave. A third party's like would breach
     * `commentLike_commentId_fkey` on the comment delete below.
     */
    for (const userId of this.created.users) {
      const theirs = await db.orm.engagement.Comment.select("id")
        .where((row) => row.userId.eq(userId))
        .all();

      for (const comment of theirs) {
        await deleteAll(() =>
          db.orm.engagement.CommentLike.where((like) =>
            like.commentId.eq(comment.id),
          ),
        );
      }
    }

    for (const userId of this.created.users) {
      await deleteAll(() =>
        db.orm.engagement.Comment.where((row) => row.userId.eq(userId)).where(
          (row) => row.parentId.isNotNull(),
        ),
      );
    }
    for (const userId of this.created.users) {
      await deleteAll(() =>
        db.orm.engagement.Comment.where((row) => row.userId.eq(userId)),
      );
    }

    for (const storyId of this.created.stories) {
      const chapters = await db.orm.content.Chapter.select("id")
        .where((chapter) => chapter.storyId.eq(storyId))
        .all();

      for (const chapter of chapters) {
        await deleteAll(() =>
          db.orm.content.Multimedia.where((item) => item.chapterId.eq(chapter.id)),
        );
        // Anonymous readers cannot like, so every row here belongs to some
        // account -- but not necessarily one of this run's fixtures.
        await deleteAll(() =>
          db.orm.engagement.ChapterLike.where((like) =>
            like.chapterId.eq(chapter.id),
          ),
        );
        // A generated recap holds a foreign key onto the chapter, so it goes
        // before the chapter does. Any suite that exercised `/api/ai/recap`
        // leaves one behind whether or not it tracked it.
        await deleteAll(() =>
          db.orm.ai.ChapterSummary.where((row) => row.chapterId.eq(chapter.id)),
        );
      }

      // Likes on this story's comments, before the comments they point at.
      const commented = await db.orm.engagement.Comment.select("id")
        .where((row) => row.storyId.eq(storyId))
        .all();

      for (const comment of commented) {
        await deleteAll(() =>
          db.orm.engagement.CommentLike.where((like) =>
            like.commentId.eq(comment.id),
          ),
        );
      }

      // Replies before threads: `Comment.parentId` points into this same table.
      await deleteAll(() =>
        db.orm.engagement.Comment.where((row) => row.storyId.eq(storyId)).where(
          (row) => row.parentId.isNotNull(),
        ),
      );
      await deleteAll(() =>
        db.orm.engagement.Comment.where((row) => row.storyId.eq(storyId)),
      );
      await deleteAll(() =>
        db.orm.engagement.ReadingHistory.where((row) => row.storyId.eq(storyId)),
      );
      // Chapter reads before the chapters they point at, and both before the
      // story: an anonymous event carries no user id, so the per-user sweep
      // above never reaches one.
      await deleteAll(() =>
        db.orm.engagement.ChapterRead.where((row) => row.storyId.eq(storyId)),
      );
      await deleteAll(() =>
        db.orm.engagement.StoryView.where((row) => row.storyId.eq(storyId)),
      );
      await deleteAll(() =>
        db.orm.engagement.Rating.where((rating) => rating.storyId.eq(storyId)),
      );
      await deleteAll(() =>
        db.orm.library.LibraryEntry.where((entry) => entry.storyId.eq(storyId)),
      );
      await deleteAll(() =>
        db.orm.content.StoryGenre.where((link) => link.storyId.eq(storyId)),
      );
      await deleteAll(() =>
        db.orm.content.Chapter.where((chapter) => chapter.storyId.eq(storyId)),
      );

      await db.orm.content.Story.where((story) => story.id.eq(storyId)).delete();
    }

    for (const genreId of this.created.genres) {
      await db.orm.content.Genre.where((genre) => genre.id.eq(genreId)).delete();
    }
    for (const userId of this.created.users) {
      await db.orm.auth.User.where((user) => user.id.eq(userId)).delete();
    }
  }
}

/**
 * True when the development database is reachable. The suites skip rather than
 * fail without it, so `pnpm test` stays runnable with the Docker stack down —
 * but they run for real wherever it is up.
 */
export async function databaseAvailable(): Promise<boolean> {
  try {
    await db.orm.content.Genre.select("id").limit(1).all();
    return true;
  } catch (error) {
    console.warn(
      "\n[books/library tests] Skipped: no database reachable at DATABASE_URL.\n" +
        "Start it with `docker compose up -d postgres` and re-run.\n" +
        `Reason: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return false;
  }
}
