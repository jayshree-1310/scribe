/**
 * Notifications: the one place anything is told to anybody.
 *
 * Six things are decided here and nowhere else.
 *
 * - **There is one `notify()`, and the services call it.** Not the routes:
 *   `createComment` has two callers' worth of reasons to exist and exactly one
 *   place a comment is written, so the notification belongs beside the write,
 *   where a second caller cannot forget it. The same rule `evaluateBadges`
 *   follows, and for the same reason.
 * - **A caller names an event, not an audience.** `notify({ event:
 *   "channel-post", ... })` says what happened; who hears about it is decided
 *   below, by the resolver for that event. A service that knew its own
 *   audience would be a second copy of the subscription rules, and the day
 *   they disagreed the quiet one would look like a bug in the other feature.
 * - **Fan-out is one statement, whatever the audience.** Each resolver is a
 *   single `INSERT ... SELECT` whose `SELECT` *is* the audience -- subscribers,
 *   members, followers. A channel with ten thousand subscribers is one round
 *   trip and no array in this process's memory, a deleted subject inserts
 *   nothing instead of breaching a foreign key, and the actor is excluded by
 *   the same `WHERE` rather than by a second query. The shape
 *   `services/analytics.ts` uses for the same reasons.
 * - **Nobody is told about their own action.** Every resolver carries
 *   `<> actor` in that `WHERE`, so it is a property of the statement and not a
 *   filter somebody has to remember. `BADGE_EARNED` is the deliberate
 *   exception and the only type with a null actor: nobody else caused it.
 * - **A mute is part of the audience, not a filter after it.** Every resolver
 *   carries `NOT EXISTS (... auth."notificationMute" ...)` for the type it
 *   writes, in the same `WHERE` that selects the recipients -- so a muted
 *   reader is never a row, rather than a row nobody shows. Filtering on the
 *   read side would have meant storing what somebody asked not to be told and
 *   trusting six query paths to remember; this way the rule is enforced by
 *   the one statement that could break it. The preferences behind it are
 *   `services/preferences.ts`, and the cost is one indexed lookup per
 *   recipient. The list of types that honour a mute is therefore exactly the
 *   list of resolvers below, and a seventh type that forgets the clause is a
 *   type nobody can turn off.
 * - **The actor is a join; the subject is a copy.** See the header of
 *   `notifications.Notification` in the contract for why those two fields are
 *   treated differently. Because the excerpt is a copy, every fan-out that
 *   quotes something a moderator can hide also records *what* it quoted, in
 *   `sourceType` / `sourceId`. That is the only handle `hideContent` in
 *   `services/moderation.ts` has on the copies, and without it hiding a
 *   comment would leave it legible in somebody's bell. `NEW_STORY` and
 *   `BADGE_EARNED` quote nothing hideable and leave both null.
 *
 * `notify` is fire-and-forget by construction: it returns `void`, so a handler
 * *cannot* await it, and it swallows its own failures into the log. Nobody
 * waits to post a comment while five hundred rows are written, and a fan-out
 * that fails must never fail the write it followed. `flushNotifications` is
 * the one seam that settles those writes -- for the tests, for a shutdown, and
 * for `deleteAccount`, which cannot open its transaction while a row naming
 * the leaving account is still in flight.
 *
 * **One event may have two audiences.** `story-comment` resolves through two
 * statements, not one: the reply's parent, if it had one, and the story's
 * author. They are mutually exclusive by construction -- `notifyCommentParent`
 * joins `reply."parentId"` and so selects nothing for a top-level comment,
 * while `notifyStoryAuthor` carries `parentId IS NULL` and so selects nothing
 * for a reply -- so exactly one of the two fires for any comment and nobody
 * gets told the same thing twice. The alternative, deciding which to run in
 * `fanOut`, would have put "is this a reply?" in two places.
 *
 * **What is deliberately not notified.** A rating is not: a score with no
 * words is not something to interrupt somebody with. A new follower is not --
 * `services/users.ts` would be the caller, and the profile already shows the
 * count. A like is not, for the rating's reason: there is nothing to read.
 * Each is a row in `NotificationType` and a resolver below, and none of them
 * is a change to anything else.
 */

import { Temporal } from "temporal-polyfill";
import { db } from "../prisma/db.js";
import { HttpError } from "../lib/http-error.js";
import { logger } from "../lib/logger.js";
import { toIso } from "./stories.js";

/** `now()` in the spelling the timestamp codec writes. */
function now(): Temporal.Instant {
  return Temporal.Now.instant();
}

/* Shapes returned to the client ------------------------------------------ */

export const NOTIFICATION_TYPES = [
  "CHANNEL_POST",
  "COMMENT_REPLY",
  "STORY_COMMENT",
  "CLUB_DISCUSSION",
  "NEW_STORY",
  "BADGE_EARNED",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** The same four fields every other author summary carries, and no more. */
export interface NotificationActor {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface Notification {
  id: string;
  type: NotificationType;
  /** The channel, club, story or badge this is about. */
  title: string;
  /** A line of the thing itself, or null where there is no body to quote. */
  excerpt: string | null;
  /** Where clicking it goes, as a web-app path. */
  href: string;
  /** Null until read. */
  readAt: string | null;
  createdAt: string;
  /** Null for `BADGE_EARNED`; nobody else caused it. */
  actor: NotificationActor | null;
}

/**
 * The shared page shape, plus the count the bell draws.
 *
 * `unreadCount` is the whole account's, never the page's and never the
 * filter's: a reader looking at page three of their read notifications still
 * has the same number of unread ones, and a badge that changed when they
 * paged would be telling them something that did not happen.
 */
export interface NotificationPage {
  items: Notification[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
  unreadCount: number;
}

export const MAX_PAGE_SIZE = 50;

/**
 * How much of a post or a reply is quoted.
 *
 * Cut in SQL rather than here, so the audience still never enters this
 * process: the excerpt is written by the same statement that chooses who
 * receives it.
 */
const EXCERPT_LENGTH = 180;

const NOTIFICATION_NOT_FOUND = "That notification could not be found.";

/* Events ----------------------------------------------------------------- */

/**
 * What a service reports, in its own vocabulary.
 *
 * Every variant names one row that has just been written and who wrote it, and
 * nothing else -- the resolver reads the rest back. Passing the rendered text
 * in would put the wording in five services instead of one, and passing the
 * audience in would put the subscription rules there.
 *
 * `badge-earned` is the one that carries text, because there is nothing to
 * read it back from: the badge catalogue is an array in
 * `services/gamification.ts` rather than a table (see that file's header), so
 * the caller is the only place the name and the description exist. Taking them
 * as arguments also keeps this module from importing that one, which imports
 * this one.
 */
export type NotificationEvent =
  | { event: "channel-post"; actorId: string; postId: string }
  | { event: "story-comment"; actorId: string; commentId: string }
  | { event: "club-discussion"; actorId: string; discussionId: string }
  | { event: "story-listed"; actorId: string; storyId: string }
  | {
      event: "badge-earned";
      userId: string;
      name: string;
      description: string;
    };

/* Fan-out ---------------------------------------------------------------- */

/**
 * In-flight fan-out writes.
 *
 * The same seam `services/analytics.ts` and `services/gamification.ts` keep,
 * and for the same three callers: a test that asserts an event notified
 * somebody, a shutdown that should not drop a write already issued, and
 * `deleteAccount`, whose transaction would otherwise race a row naming the
 * account it is deleting.
 */
const pending = new Set<Promise<unknown>>();

/**
 * Settles every fan-out write issued so far.
 *
 * **Drain this last.** A badge award is itself fire-and-forget and calls
 * `notify` when it lands, so a notification can be issued *after* this returns
 * by work `flushBadges` has not settled yet. Draining the two in parallel --
 * `Promise.all([flushBadges(), flushNotifications()])` -- therefore loses the
 * badge notification about one time in ten, which is the worst kind of flake:
 * rare, real, and about the one write nobody is watching. Every caller awaits
 * `flushBadges()` first and this second, and the comment at each of them says
 * so.
 */
export async function flushNotifications(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}

/**
 * Tells whoever should hear about `event`.
 *
 * `void`, so no handler can accidentally make somebody wait for it, and no
 * failure here can fail the write it followed. Call it from the service that
 * performed that write, immediately after the transaction commits -- inside
 * one, a rollback would leave notifications about something that never
 * happened.
 */
export function notify(event: NotificationEvent): void {
  const work = fanOut(event).catch((error: unknown) => {
    // A notification is never worth a failed request. Warn rather than error,
    // the level `services/analytics.ts` logs a dropped event at: a broken
    // fan-out should be visible without being paged on.
    logger.warn({ err: error, event: event.event }, "notifications: fan-out failed");
  });

  pending.add(work);
  void work.finally(() => pending.delete(work));
}

async function fanOut(event: NotificationEvent): Promise<void> {
  switch (event.event) {
    case "channel-post":
      return notifySubscribers(event.postId);
    case "story-comment":
      return notifyComment(event.commentId);
    case "club-discussion":
      return notifyClub(event.discussionId);
    case "story-listed":
      return notifyFollowers(event.storyId);
    case "badge-earned":
      return notifyEarner(event.userId, event.name, event.description);
  }
}

/**
 * A new post, to everybody subscribed to the channel it was posted in.
 *
 * The channel's author is excluded although they are also the only person who
 * can post: an author subscribed to their own channel would otherwise be told
 * about their own announcement.
 */
async function notifySubscribers(postId: string): Promise<void> {
  const plan = db.raw.sql`
    INSERT INTO "notifications"."notification"
      ("id", "userId", "type", "actorId", "title", "excerpt", "href",
       "sourceType", "sourceId", "createdAt")
    SELECT gen_random_uuid()::text,
           sub."userId",
           'CHANNEL_POST',
           ch."authorId",
           ch."name",
           left(post."title", ${EXCERPT_LENGTH}),
           '/channels/' || ch."slug",
           'CHANNEL_POST',
           post."id",
           now()
      FROM "channels"."channelPost" AS post
      JOIN "channels"."broadcastChannel" AS ch ON ch."id" = post."channelId"
      JOIN "channels"."channelSubscriber" AS sub ON sub."channelId" = ch."id"
     WHERE post."id" = ${postId}
       AND sub."userId" <> ch."authorId"
       AND NOT EXISTS (
             SELECT 1 FROM "auth"."notificationMute" AS mute
              WHERE mute."userId" = sub."userId"
                AND mute."type" = 'CHANNEL_POST'
           )
  `.affectedCount().build();

  await db.runtime().query(plan);
}

/**
 * Both audiences a story comment can have. See the header for why this is two
 * statements and why only one of them can match.
 *
 * Sequential rather than `Promise.all`: they are two writes to the same table
 * in the same fan-out, and nothing is waiting on them -- `notify` already made
 * this fire-and-forget -- so there is no latency to win and one less
 * connection to hold.
 */
async function notifyComment(commentId: string): Promise<void> {
  await notifyCommentParent(commentId);
  await notifyStoryAuthor(commentId);
}

/**
 * A reply on a story, to the author of the comment it answers.
 *
 * Nothing at all for a top-level comment: the join to `parent` is what makes
 * "this is a reply" and "here is who to tell" the same condition, so a comment
 * with no parent selects no rows rather than being filtered out afterwards.
 *
 * The link is the chapter the thread sits under when it has one, and the story
 * page otherwise -- a reader's comment panel is chapter-scoped, and sending
 * somebody to the story page to find which of forty chapters was being
 * discussed is the kind of link people stop clicking.
 */
async function notifyCommentParent(commentId: string): Promise<void> {
  const plan = db.raw.sql`
    INSERT INTO "notifications"."notification"
      ("id", "userId", "type", "actorId", "title", "excerpt", "href",
       "sourceType", "sourceId", "createdAt")
    SELECT gen_random_uuid()::text,
           parent."userId",
           'COMMENT_REPLY',
           reply."userId",
           story."title",
           left(reply."content", ${EXCERPT_LENGTH}),
           CASE
             WHEN chapter."id" IS NULL THEN '/story/' || story."slug"
             ELSE '/read/' || story."slug" || '/' || chapter."chapterNumber"
           END,
           'COMMENT',
           reply."id",
           now()
      FROM "engagement"."comment" AS reply
      JOIN "engagement"."comment" AS parent ON parent."id" = reply."parentId"
      JOIN "content"."story" AS story ON story."id" = reply."storyId"
      LEFT JOIN "content"."chapter" AS chapter ON chapter."id" = reply."chapterId"
     WHERE reply."id" = ${commentId}
       AND parent."userId" <> reply."userId"
       AND NOT EXISTS (
             SELECT 1 FROM "auth"."notificationMute" AS mute
              WHERE mute."userId" = parent."userId"
                AND mute."type" = 'COMMENT_REPLY'
           )
  `.affectedCount().build();

  await db.runtime().query(plan);
}

/**
 * A new comment on a story, to the story's author.
 *
 * `parentId IS NULL` is what keeps this from doubling up with the reply
 * notification above: a reply is addressed to whoever wrote what it answers,
 * and telling the author about it as well would be two rows for one comment --
 * and three lines in the bell for an author replying under their own story.
 * The two conditions live in the two statements rather than in `fanOut`, so
 * "is this a reply?" is asked once, by the row itself.
 *
 * The author is joined through `story."authorId"` rather than passed in, for
 * the reason every resolver here reads its subject back: `createComment` knows
 * the story id and not who wrote it, and looking it up there would be a round
 * trip on the request's own path for a row this statement already touches.
 *
 * The link is the chapter when the comment has one, as the reply's is -- an
 * author following "somebody commented" to the story page and then hunting
 * which of forty chapters it was about is the kind of link people stop
 * clicking. `sourceType` / `sourceId` are recorded so hiding the comment
 * sweeps this copy of it; see `hideContent` in `services/moderation.ts`.
 */
async function notifyStoryAuthor(commentId: string): Promise<void> {
  const plan = db.raw.sql`
    INSERT INTO "notifications"."notification"
      ("id", "userId", "type", "actorId", "title", "excerpt", "href",
       "sourceType", "sourceId", "createdAt")
    SELECT gen_random_uuid()::text,
           story."authorId",
           'STORY_COMMENT',
           comment."userId",
           story."title",
           left(comment."content", ${EXCERPT_LENGTH}),
           CASE
             WHEN chapter."id" IS NULL THEN '/story/' || story."slug"
             ELSE '/read/' || story."slug" || '/' || chapter."chapterNumber"
           END,
           'COMMENT',
           comment."id",
           now()
      FROM "engagement"."comment" AS comment
      JOIN "content"."story" AS story ON story."id" = comment."storyId"
      LEFT JOIN "content"."chapter" AS chapter ON chapter."id" = comment."chapterId"
     WHERE comment."id" = ${commentId}
       AND comment."parentId" IS NULL
       AND story."authorId" <> comment."userId"
       AND NOT EXISTS (
             SELECT 1 FROM "auth"."notificationMute" AS mute
              WHERE mute."userId" = story."authorId"
                AND mute."type" = 'STORY_COMMENT'
           )
  `.affectedCount().build();

  await db.runtime().query(plan);
}

/**
 * A club thread, to the whole club; a club reply, to the person replied to.
 *
 * Two statements and one event, because "activity in a club you belong to" is
 * the wrong thing to send for a reply: a thread that gets twenty of them would
 * be twenty notifications for every member, and the club would be muted by
 * everybody within a week. A reply is addressed to whoever wrote what it
 * answers, which is the same rule story comments follow -- the same
 * `COMMENT_REPLY` type, deliberately, because a reader does not care which
 * surface a reply to them arrived on.
 *
 * Only one of the two can match: a discussion either has a `parentId` or it
 * does not, so this runs both and lets the `WHERE` decide.
 */
async function notifyClub(discussionId: string): Promise<void> {
  const thread = db.raw.sql`
    INSERT INTO "notifications"."notification"
      ("id", "userId", "type", "actorId", "title", "excerpt", "href",
       "sourceType", "sourceId", "createdAt")
    SELECT gen_random_uuid()::text,
           member."userId",
           'CLUB_DISCUSSION',
           post."userId",
           club."name",
           left(post."body", ${EXCERPT_LENGTH}),
           '/clubs/' || club."slug",
           'CLUB_DISCUSSION',
           post."id",
           now()
      FROM "clubs"."clubDiscussion" AS post
      JOIN "clubs"."bookClub" AS club ON club."id" = post."clubId"
      JOIN "clubs"."clubMembership" AS member ON member."clubId" = club."id"
     WHERE post."id" = ${discussionId}
       AND post."parentId" IS NULL
       AND member."userId" <> post."userId"
       AND NOT EXISTS (
             SELECT 1 FROM "auth"."notificationMute" AS mute
              WHERE mute."userId" = member."userId"
                AND mute."type" = 'CLUB_DISCUSSION'
           )
  `.affectedCount().build();

  const reply = db.raw.sql`
    INSERT INTO "notifications"."notification"
      ("id", "userId", "type", "actorId", "title", "excerpt", "href",
       "sourceType", "sourceId", "createdAt")
    SELECT gen_random_uuid()::text,
           parent."userId",
           'COMMENT_REPLY',
           post."userId",
           club."name",
           left(post."body", ${EXCERPT_LENGTH}),
           '/clubs/' || club."slug",
           'CLUB_DISCUSSION',
           post."id",
           now()
      FROM "clubs"."clubDiscussion" AS post
      JOIN "clubs"."clubDiscussion" AS parent ON parent."id" = post."parentId"
      JOIN "clubs"."bookClub" AS club ON club."id" = post."clubId"
     WHERE post."id" = ${discussionId}
       AND parent."userId" <> post."userId"
       AND NOT EXISTS (
             SELECT 1 FROM "auth"."notificationMute" AS mute
              WHERE mute."userId" = parent."userId"
                AND mute."type" = 'COMMENT_REPLY'
           )
  `.affectedCount().build();

  await db.runtime().query(thread);
  await db.runtime().query(reply);
}

/**
 * A newly listed story, to everybody following its author.
 *
 * `listedAt IS NOT NULL` is re-checked here rather than trusted from the
 * caller: this runs after the transaction committed, and a story unlisted in
 * between should not announce itself. `publishStory` is the only caller and
 * only fires on the transition, so a re-publish after an unpublish does not
 * announce twice -- see the comment there.
 */
async function notifyFollowers(storyId: string): Promise<void> {
  const plan = db.raw.sql`
    INSERT INTO "notifications"."notification"
      ("id", "userId", "type", "actorId", "title", "excerpt", "href", "createdAt")
    SELECT gen_random_uuid()::text,
           follow."followerId",
           'NEW_STORY',
           story."authorId",
           story."title",
           left(story."description", ${EXCERPT_LENGTH}),
           '/story/' || story."slug",
           now()
      FROM "content"."story" AS story
      JOIN "engagement"."follow" AS follow ON follow."followingId" = story."authorId"
     WHERE story."id" = ${storyId}
       AND story."listedAt" IS NOT NULL
       AND follow."followerId" <> story."authorId"
       AND NOT EXISTS (
             SELECT 1 FROM "auth"."notificationMute" AS mute
              WHERE mute."userId" = follow."followerId"
                AND mute."type" = 'NEW_STORY'
           )
  `.affectedCount().build();

  await db.runtime().query(plan);
}

/**
 * A badge, to the person who earned it.
 *
 * The one type addressed to the actor, and so the one with a null `actorId`:
 * there is no "somebody" who did this, and drawing this row with the
 * recipient's own avatar beside it would say there was.
 *
 * Exactly once per award without any dedupe of its own, because
 * `insertBadge` in `services/gamification.ts` returns a row only for the
 * insert that actually landed -- two evaluations racing on the same badge
 * produce one caller here, not two.
 */
async function notifyEarner(
  userId: string,
  name: string,
  description: string,
): Promise<void> {
  const plan = db.raw.sql`
    INSERT INTO "notifications"."notification"
      ("id", "userId", "type", "actorId", "title", "excerpt", "href", "createdAt")
    SELECT gen_random_uuid()::text,
           ${userId},
           'BADGE_EARNED',
           NULL,
           ${name},
           left(${description}::text, ${EXCERPT_LENGTH}),
           '/badges',
           now()
     WHERE NOT EXISTS (
             SELECT 1 FROM "auth"."notificationMute" AS mute
              WHERE mute."userId" = ${userId}
                AND mute."type" = 'BADGE_EARNED'
           )
  `.affectedCount().build();

  await db.runtime().query(plan);
}

/* Reading ---------------------------------------------------------------- */

interface NotificationRow {
  id: string;
  type: string;
  actorId: string | null;
  title: string;
  excerpt: string | null;
  href: string;
  readAt: unknown;
  createdAt: unknown;
}

export interface NotificationQuery {
  page: number;
  limit: number;
  /** Narrows the list to what has not been read. The count is unaffected. */
  unreadOnly?: boolean | undefined;
}

/**
 * One person's notifications, newest first, with their unread count.
 *
 * `createdAt` descending with `id` as the tie-breaker, the shared shape every
 * other paginated list here uses: two notifications written in the same
 * millisecond -- which a fan-out of five hundred rows guarantees -- cannot
 * swap places between pages and show one of them twice.
 */
export async function listNotifications(
  userId: string,
  query: NotificationQuery,
): Promise<NotificationPage> {
  const mine = () =>
    db.orm.notifications.Notification.where((row) => row.userId.eq(userId));

  let collection = db.orm.notifications.Notification.select(
    "id",
    "type",
    "actorId",
    "title",
    "excerpt",
    "href",
    "readAt",
    "createdAt",
  ).where((row) => row.userId.eq(userId));

  if (query.unreadOnly) {
    collection = collection.where((row) => row.readAt.isNull());
  }

  const [totals, unread] = await Promise.all([
    collection.aggregate((aggregate) => ({ total: aggregate.count() })),
    mine()
      .where((row) => row.readAt.isNull())
      .aggregate((aggregate) => ({ total: aggregate.count() })),
  ]);

  const rows = await collection
    .orderBy([(row) => row.createdAt.desc(), (row) => row.id.desc()])
    .offset((query.page - 1) * query.limit)
    .limit(query.limit)
    .all();

  const total = totals.total;

  return {
    items: await hydrate(rows as NotificationRow[]),
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.ceil(total / query.limit),
    hasMore: query.page * query.limit < total,
    unreadCount: unread.total,
  };
}

/** The unread count on its own, for a poll that only needs the badge. */
export async function countUnread(userId: string): Promise<number> {
  const { total } = await db.orm.notifications.Notification.where((row) =>
    row.userId.eq(userId),
  )
    .where((row) => row.readAt.isNull())
    .aggregate((aggregate) => ({ total: aggregate.count() }));

  return total;
}

async function hydrate(rows: NotificationRow[]): Promise<Notification[]> {
  if (rows.length === 0) return [];

  const actorIds = rows
    .map((row) => row.actorId)
    .filter((id): id is string => id !== null);

  const actors = await actorsByIds(actorIds);

  return rows
    .map((row) => {
      /**
       * A type this build does not know about is dropped rather than shown.
       * The CHECK constraint makes it impossible going forward, but a rollback
       * past a migration that added one leaves rows the client cannot draw,
       * and a blank line in a dropdown is worse than a shorter list.
       */
      if (!isKnownType(row.type)) return null;

      return {
        id: row.id,
        type: row.type,
        title: row.title,
        excerpt: row.excerpt,
        href: row.href,
        readAt: toIso(row.readAt),
        createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
        // A notification whose actor has since deleted their account keeps its
        // frozen title and simply loses the face beside it -- the thing that
        // happened still happened.
        actor: row.actorId === null ? null : actors.get(row.actorId) ?? null,
      };
    })
    .filter((item): item is Notification => item !== null);
}

function isKnownType(value: string): value is NotificationType {
  return (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

async function actorsByIds(
  ids: string[],
): Promise<Map<string, NotificationActor>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();

  const rows = await db.orm.auth.User.select(
    "id",
    "username",
    "displayName",
    "avatarUrl",
  )
    .where((user) => user.id.in(unique))
    .all();

  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        username: row.username,
        displayName: row.displayName,
        avatarUrl: row.avatarUrl,
      },
    ]),
  );
}

/* Marking read ----------------------------------------------------------- */

/**
 * Marks one notification read, and answers with the account's new unread
 * count.
 *
 * The count rather than the row: the only thing the client redraws is the
 * bell, and making it ask again would be a second round trip for a number this
 * request already had to touch.
 *
 * Scoped to the caller, so reading somebody else's notification is a 404
 * rather than a 403 -- the id of a row that is not yours is not something the
 * API should confirm exists.
 */
export async function markRead(
  userId: string,
  notificationId: string,
): Promise<{ unreadCount: number }> {
  const updated = await db.orm.notifications.Notification.where((row) =>
    row.id.eq(notificationId),
  )
    .where((row) => row.userId.eq(userId))
    // Already read: leave `readAt` at the moment it was first read rather than
    // moving it, so a double click does not rewrite history.
    .where((row) => row.readAt.isNull())
    .update({ readAt: now() });

  if (updated === null) {
    /**
     * Either it is not theirs, or it was already read. Those have to be told
     * apart: marking an already-read notification read is a no-op the client
     * may well repeat, and answering 404 to it would make a second click look
     * like a failure.
     */
    const exists = await db.orm.notifications.Notification.select("id")
      .where((row) => row.id.eq(notificationId))
      .where((row) => row.userId.eq(userId))
      .first();

    if (!exists) throw HttpError.notFound(NOTIFICATION_NOT_FOUND);
  }

  return { unreadCount: await countUnread(userId) };
}

/**
 * Marks everything read.
 *
 * Raw SQL rather than the ORM, for the reason `prisma/delete-all.ts` gives
 * about `delete`: `where(...).update(...)` writes **one** row per call however
 * many the predicate matches. Looping it -- the `deleteAll` shape -- would be
 * a round trip per notification, and a reader who has ignored the bell for a
 * month has hundreds. One statement over the `[userId, readAt]` index is what
 * this actually wants, and there is nothing to lose to a race: a notification
 * arriving mid-sweep is simply unread, which is true.
 */
export async function markAllRead(
  userId: string,
): Promise<{ unreadCount: number }> {
  const plan = db.raw.sql`
    UPDATE "notifications"."notification"
       SET "readAt" = now()
     WHERE "userId" = ${userId}
       AND "readAt" IS NULL
  `.affectedCount().build();

  await db.runtime().query(plan);

  return { unreadCount: await countUnread(userId) };
}
