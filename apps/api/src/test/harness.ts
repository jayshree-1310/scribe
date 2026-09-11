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
    users: [] as string[],
  };

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

  async createUser(label: string): Promise<string> {
    const username = `${this.runId}-${label}`.slice(0, 30);
    const user = await db.orm.auth.User.select("id").create({
      username,
      email: `${username}@fixtures.invalid`,
      passwordHash: UNUSABLE_PASSWORD_HASH,
    });

    this.created.users.push(user.id);
    return user.id;
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
  }): Promise<string> {
    const story = await db.orm.content.Story.select("id").create({
      authorId: input.authorId,
      title: input.title,
      description: `${input.title} — fixture`,
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
  }): Promise<{ id: string; slug: string }> {
    const slug = `${this.runId}-${input.slug ?? slugify(input.title)}`.slice(0, 80);

    const story = await db.orm.content.Story.select("id").create({
      authorId: input.authorId,
      title: input.title,
      description: `${input.title} — fixture`,
      slug,
      source: "SCRIBE",
      listedAt: input.listed === false ? null : Temporal.Now.instant(),
      isCompleted: input.isCompleted ?? false,
      ratingAverage:
        input.ratingAverage === null ? null : String(input.ratingAverage ?? 4),
      viewCount: input.viewCount ?? 0,
      likeCount: input.likeCount ?? 0,
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

  /** A reader's streak as stored, for asserting what a write did. */
  async readStreak(
    userId: string,
  ): Promise<{ streak: number; lastReadAt: Date | null }> {
    const user = await db.orm.auth.User.select(
      "readingStreak",
      "streakLastReadAt",
    )
      .where((row) => row.id.eq(userId))
      .first();

    if (!user) throw new Error(`no such fixture user: ${userId}`);

    return {
      streak: user.readingStreak,
      lastReadAt:
        user.streakLastReadAt === null || user.streakLastReadAt === undefined
          ? null
          : new Date(String(user.streakLastReadAt)),
    };
  }

  /* Teardown -------------------------------------------------------------- */

  private async cleanup(): Promise<void> {
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
    }

    for (const storyId of this.created.stories) {
      const chapters = await db.orm.content.Chapter.select("id")
        .where((chapter) => chapter.storyId.eq(storyId))
        .all();

      for (const chapter of chapters) {
        await deleteAll(() =>
          db.orm.content.Multimedia.where((item) => item.chapterId.eq(chapter.id)),
        );
      }

      await deleteAll(() =>
        db.orm.engagement.Comment.where((row) => row.storyId.eq(storyId)),
      );
      await deleteAll(() =>
        db.orm.engagement.ReadingHistory.where((row) => row.storyId.eq(storyId)),
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
