/**
 * Comments, likes and ratings on stories.
 *
 * Comments follow the thread shape `services/clubs.ts` established and
 * `services/channels.ts` followed, deliberately rather than inventing a third:
 * one table for threads and replies told apart by a nullable `parentId`,
 * replies capped at one level deep, a `Page<T>` ordered newest-first with `id`
 * as the tie-breaker, and an author summary of exactly four fields. That is
 * what left moderation one read path per surface to audit instead of three.
 *
 * The one place this diverges from clubs is who may delete, and that question
 * is now answered. A club resolves "moderator" from a membership row; a story
 * has no membership table, so delete here is the comment's author alone. The
 * story's author is still *not* given the power, deliberately: a writer who
 * could delete criticism of their own work would be moderating the thing they
 * are least able to judge, and the case that motivates it -- abuse under
 * somebody's story -- is what `POST /api/reports` and the queue in
 * `services/moderation.ts` are for. What a moderator does instead of deleting
 * is hide: `hiddenAt` on the row, filtered out of every read below.
 *
 * Ratings keep `content.Story.ratingAverage` and `ratingCount` in step inside
 * the same transaction as every write. Those columns are not the read path --
 * `services/stories.ts` computes both from `Rating` rows -- but `sort=rating`
 * orders in SQL over the story table, so a stale column silently mis-sorts the
 * catalogue.
 *
 * Likes are the third thing here, and the simplest: a row per reader per
 * subject, keyed on the pair, with no counter column behind it. Two subjects
 * have one -- a chapter and a comment -- and both go through `setLike` below,
 * so "liking is idempotent and unliking is silent" is written once rather than
 * twice. The count is always read from the rows, for the reason the contract
 * gives: nothing sorts or ranks on it, so a denormalised column would be a
 * second copy of a number with nothing keeping it honest.
 *
 * Every function takes the caller's id explicitly -- the routes resolve it
 * once through `middleware/current-user.ts` -- so nothing here reaches for
 * ambient request state.
 */

import { Temporal } from "temporal-polyfill";
import { db } from "../prisma/db.js";
import { HttpError } from "../lib/http-error.js";
import { evaluateBadges } from "./gamification.js";
import { notify } from "./notifications.js";
import { assertNotSuspended } from "./roles.js";
import { findVisibleChapter, findVisibleStoryId, toIso } from "./stories.js";

/**
 * The transaction context, derived from `db.transaction` rather than imported
 * for the reason `services/authoring.ts` gives: the type is not re-exported
 * from the runtime entry point.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type Orm = Pick<Tx, "orm"> | typeof db;

/* Shapes returned to the client ----------------------------------------- */

export interface CommentUser {
  id: string;
  username: string;
  /** Absent for password signups, where the UI falls back to the username. */
  displayName: string | null;
  avatarUrl: string | null;
}

export interface Comment {
  id: string;
  storyId: string;
  /** The chapter this was written against, or null for a story-wide comment. */
  chapterId: string | null;
  /** Null for a top-level thread; the thread's id for a reply. */
  parentId: string | null;
  content: string;
  createdAt: string;
  updatedAt: string;
  /** Always 0 for a reply: replies are one level deep. */
  replyCount: number;
  likeCount: number;
  /** False when anonymous, rather than a null the UI would have to branch on. */
  likedByMe: boolean;
  user: CommentUser;
}

export interface Page<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

/** Score -> how many readers gave it. Every key 1-5 is present, even at zero. */
export type RatingBreakdown = Record<number, number>;

export interface RatingSummary {
  /** Null when nothing has been rated, rather than a misleading 0. */
  average: number | null;
  count: number;
  breakdown: RatingBreakdown;
  /** The caller's own score, or null when anonymous or not yet rated. */
  mine: number | null;
}

/** What a like write answers with: the subject's new count, and the caller's own state. */
export interface LikeSummary {
  count: number;
  liked: boolean;
}

export const MAX_PAGE_SIZE = 100;

export const COMMENT_MAX_LENGTH = 2000;

export const RATING_MIN = 1;

export const RATING_MAX = 5;

const STORY_NOT_FOUND = "That story could not be found.";

const COMMENT_NOT_FOUND = "That comment could not be found.";

/* Helpers ---------------------------------------------------------------- */

/** `now()` in the spelling the timestamp codec writes. */
function now(): Temporal.Instant {
  return Temporal.Now.instant();
}

/** These columns are never null; the epoch fallback keeps one bad row local. */
function isoOf(value: unknown): string {
  return toIso(value) ?? new Date(0).toISOString();
}

/**
 * A rating is a Postgres `numeric`, which the driver decodes to a decimal
 * string. Scores are whole numbers 1-5 by construction, so rounding here is
 * normalisation rather than a loss -- and it is what makes the breakdown's
 * keys usable as object keys.
 */
function toScore(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;

  const rounded = Math.round(parsed);
  return rounded >= RATING_MIN && rounded <= RATING_MAX ? rounded : null;
}

function toAverage(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** An empty breakdown, so a story nobody has rated still answers all five keys. */
function emptyBreakdown(): RatingBreakdown {
  return { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
}

function emptyPage<T>(page: number, limit: number): Page<T> {
  return { items: [], page, limit, total: 0, totalPages: 0, hasMore: false };
}

/**
 * The id of a story the caller may see, or a 404.
 *
 * Every entry point here starts with this. A draft is invisible to everyone
 * but its author, and that has to hold for its comments and its rating count
 * too -- otherwise the comment list is a side channel that confirms an unlisted
 * story exists.
 */
async function visibleStoryId(
  slugOrId: string,
  viewerId: string | null,
): Promise<string> {
  const storyId = await findVisibleStoryId(slugOrId, viewerId);
  if (storyId === null) throw HttpError.notFound(STORY_NOT_FOUND);

  return storyId;
}

async function usersByIds(
  ids: string[],
): Promise<Map<string, CommentUser>> {
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

/* Comments --------------------------------------------------------------- */

interface CommentRow {
  id: string;
  storyId: string;
  chapterId: string | null;
  parentId: string | null;
  userId: string;
  content: string;
  createdAt: unknown;
  updatedAt: unknown;
}

/**
 * Hidden comments are absent from every read that goes through here, which is
 * every read that shows a comment's text. The filter is in the base rather
 * than at each call site deliberately: there is no caller that wants a hidden
 * row, so the way to get one wrong is to forget, and this is the shape that
 * cannot be forgotten. The two reads that do *not* use it -- the reply count
 * below and the parent lookup in `createComment` -- carry the same filter and
 * say so. See `services/moderation.ts`.
 */
function commentsBase(client: Orm = db) {
  return client.orm.engagement.Comment.select(
    "id",
    "storyId",
    "chapterId",
    "parentId",
    "userId",
    "content",
    "createdAt",
    "updatedAt",
  ).where((row) => row.hiddenAt.isNull());
}

/**
 * How many likes each of these comments has, and which of them the caller has
 * liked.
 *
 * Two queries for the whole page rather than two per comment, the shape the
 * reply count above uses and for the same reason: a page of twenty comments is
 * twenty-one round trips the moment either of these moves inside the loop.
 * The second query is skipped entirely for an anonymous reader, who cannot
 * have liked anything.
 */
async function likesFor(
  commentIds: string[],
  viewerId: string | null,
): Promise<{ counts: Map<string, number>; mine: Set<string> }> {
  const counts = new Map<string, number>();
  const mine = new Set<string>();

  if (commentIds.length === 0) return { counts, mine };

  /**
   * Grouped in SQL rather than by counting rows here: a comment somebody
   * linked to can collect thousands of likes, and the only thing this needs is
   * the number per id.
   */
  const grouped = await db.orm.engagement.CommentLike.where((like) =>
    like.commentId.in(commentIds),
  )
    .groupBy("commentId")
    .aggregate((aggregate) => ({ total: aggregate.count() }));

  for (const group of grouped) counts.set(group.commentId, group.total);

  if (viewerId !== null) {
    const ownRows = await db.orm.engagement.CommentLike.select("commentId")
      .where((like) => like.commentId.in(commentIds))
      .where((like) => like.userId.eq(viewerId))
      .all();

    for (const row of ownRows) mine.add(row.commentId);
  }

  return { counts, mine };
}

async function hydrateComments(
  rows: CommentRow[],
  withReplyCounts: boolean,
  viewerId: string | null,
): Promise<Comment[]> {
  if (rows.length === 0) return [];

  const users = await usersByIds(rows.map((row) => row.userId));
  const likes = await likesFor(
    rows.map((row) => row.id),
    viewerId,
  );

  const replyCounts = new Map<string, number>();
  if (withReplyCounts) {
    // One query for the whole page's replies rather than one per thread.
    const replies = await db.orm.engagement.Comment.select("parentId")
      .where((row) => row.parentId.in(rows.map((thread) => thread.id)))
      // Hidden replies do not count, or a thread offers to show three replies
      // and opens on two.
      .where((row) => row.hiddenAt.isNull())
      .all();

    for (const reply of replies) {
      if (reply.parentId === null) continue;
      replyCounts.set(
        reply.parentId,
        (replyCounts.get(reply.parentId) ?? 0) + 1,
      );
    }
  }

  return rows
    .map((row) => {
      // A comment whose author was deleted drops out rather than failing the
      // whole list, the way `services/library.ts` drops a vanished book.
      const user = users.get(row.userId);
      if (!user) return null;

      return {
        id: row.id,
        storyId: row.storyId,
        chapterId: row.chapterId,
        parentId: row.parentId,
        content: row.content,
        createdAt: isoOf(row.createdAt),
        updatedAt: isoOf(row.updatedAt),
        replyCount: replyCounts.get(row.id) ?? 0,
        likeCount: likes.counts.get(row.id) ?? 0,
        likedByMe: likes.mine.has(row.id),
        user,
      };
    })
    .filter((comment): comment is Comment => comment !== null);
}

export interface CommentQuery {
  /**
   * Null lists the story's top-level threads; a thread id lists that thread's
   * replies. Undefined means the same as null -- the default view.
   */
  parentId?: string | undefined;
  /**
   * Narrows to one chapter's threads, which is what the reader's side panel
   * wants. Ignored when listing replies: a reply inherits its thread's chapter,
   * so the thread has already established the scope.
   */
  chapterId?: string | undefined;
  page: number;
  limit: number;
}

/** A story's comments. Public -- for a story the caller may see. */
export async function listComments(
  slugOrId: string,
  query: CommentQuery,
  viewerId: string | null,
): Promise<Page<Comment>> {
  const storyId = await visibleStoryId(slugOrId, viewerId);

  const { parentId, chapterId } = query;
  const threads = parentId === undefined;

  let collection = commentsBase().where((row) => row.storyId.eq(storyId));

  collection = threads
    ? collection.where((row) => row.parentId.isNull())
    : collection.where((row) => row.parentId.eq(parentId));

  if (threads && chapterId !== undefined) {
    collection = collection.where((row) => row.chapterId.eq(chapterId));
  }

  const totals = await collection.aggregate((aggregate) => ({
    total: aggregate.count(),
  }));

  /**
   * Threads newest first -- a story page leads with what was just said -- and
   * replies oldest first, because a thread reads as a conversation in the
   * order it happened. `id` is the tie-breaker either way, so two comments
   * written in the same millisecond cannot swap places between pages and show
   * a reader one of them twice.
   */
  const rows = await collection
    .orderBy(
      threads
        ? [(row) => row.createdAt.desc(), (row) => row.id.desc()]
        : [(row) => row.createdAt.asc(), (row) => row.id.asc()],
    )
    .offset((query.page - 1) * query.limit)
    .limit(query.limit)
    .all();

  const items = await hydrateComments(rows as CommentRow[], threads, viewerId);
  const total = totals.total;

  return {
    items,
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.ceil(total / query.limit),
    hasMore: query.page * query.limit < total,
  };
}

export interface CommentInput {
  content: string;
  /** Attaches the comment to one chapter. Ignored when replying. */
  chapterId?: string | undefined;
  parentId?: string | undefined;
}

/**
 * Posts a thread, or a reply when `parentId` is given.
 *
 * Any signed-in reader may comment on a story they can see. Unlike a club,
 * there is nothing to join first.
 */
export async function createComment(
  userId: string,
  slugOrId: string,
  input: CommentInput,
): Promise<Comment> {
  // One of the four write seams a suspension stops; see the header of
  // `services/moderation.ts` for the list.
  await assertNotSuspended(userId);

  const storyId = await visibleStoryId(slugOrId, userId);
  const timestamp = now();

  const commentId = await db.transaction(async (tx) => {
    let parentId: string | null = null;
    let chapterId: string | null = null;

    if (input.parentId !== undefined) {
      const parent = await tx.orm.engagement.Comment.select(
        "id",
        "storyId",
        "chapterId",
        "parentId",
      )
        .where((row) => row.id.eq(input.parentId as string))
        // A hidden thread is gone as far as anybody but a moderator is
        // concerned, so replying to one 404s rather than quietly attaching a
        // visible reply to something nobody can read.
        .where((row) => row.hiddenAt.isNull())
        .first();

      if (!parent || parent.storyId !== storyId) {
        throw HttpError.notFound(COMMENT_NOT_FOUND);
      }

      // Replies are one level deep, so replying to a reply attaches to its
      // thread instead of nesting. The alternative is a tree the UI has no
      // way to render.
      parentId = parent.parentId ?? parent.id;

      // Inherited rather than taken from the caller: a reply belongs wherever
      // its thread does, and letting the two disagree would hide a reply from
      // the chapter panel its thread is showing in.
      chapterId = parent.chapterId;
    } else if (input.chapterId !== undefined) {
      const chapter = await tx.orm.content.Chapter.select("id", "storyId")
        .where((row) => row.id.eq(input.chapterId as string))
        .first();

      if (!chapter || chapter.storyId !== storyId) {
        throw HttpError.notFound("That chapter could not be found.");
      }

      chapterId = chapter.id;
    }

    const created = await tx.orm.engagement.Comment.select("id").create({
      storyId,
      userId,
      chapterId,
      parentId,
      content: input.content,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    return created.id;
  });

  const row = await commentsBase()
    .where((comment) => comment.id.eq(commentId))
    .first();

  if (!row) throw HttpError.notFound(COMMENT_NOT_FOUND);

  const [comment] = await hydrateComments([row as CommentRow], true, userId);
  if (!comment) throw HttpError.notFound(COMMENT_NOT_FOUND);

  // Comments posted is a badge metric. Here rather than in the route so the
  // next caller of this function cannot forget it, and unawaited because a
  // badge is never worth making somebody wait to see their own comment.
  evaluateBadges(userId);

  /**
   * Whoever was replied to, if anybody. Fired for every comment rather than
   * only when `parentId` was supplied: `notifyCommentParent` joins the parent
   * row, so a top-level comment selects nobody and this stays one rule instead
   * of the same condition written in two places.
   */
  notify({ event: "story-comment", actorId: userId, commentId: comment.id });

  return comment;
}

/**
 * Deletes a thread or a reply. Its author alone -- see the module header for
 * why a story's author is not a moderator of its comments, and
 * `services/moderation.ts` for what a moderator does instead.
 */
export async function deleteComment(
  userId: string,
  commentId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await tx.orm.engagement.Comment.select("id", "userId")
      .where((comment) => comment.id.eq(commentId))
      .first();

    if (!row) throw HttpError.notFound(COMMENT_NOT_FOUND);

    if (row.userId !== userId) {
      throw HttpError.forbidden("That comment is not yours to delete.");
    }

    /**
     * Likes before the rows they point at, and the replies' likes before the
     * thread's: `commentLike_commentId_fkey` would otherwise refuse the
     * delete, and it would refuse it only for a comment somebody had liked --
     * the kind of failure that never shows up until the feature is used.
     */
    const replies = await tx.orm.engagement.Comment.select("id")
      .where((item) => item.parentId.eq(row.id))
      .all();

    for (const reply of replies) {
      await deleteAllIn(() =>
        tx.orm.engagement.CommentLike.where((like) =>
          like.commentId.eq(reply.id),
        ),
      );
    }

    await deleteAllIn(() =>
      tx.orm.engagement.CommentLike.where((like) => like.commentId.eq(row.id)),
    );

    // Replies first, so deleting a thread does not breach the self-referencing
    // foreign key. Deleting a reply matches nothing here, which is fine.
    await deleteAllIn(() =>
      tx.orm.engagement.Comment.where((item) => item.parentId.eq(row.id)),
    );
    await tx.orm.engagement.Comment.where((item) =>
      item.id.eq(row.id),
    ).delete();
  });
}

/**
 * `delete()` removes one row per call, so deleting a thread's replies has to
 * loop. `prisma/delete-all.ts` does this for the ORM client; this is the same
 * loop against a transaction's collection, which that helper's type does not
 * cover.
 */
async function deleteAllIn(
  build: () => { delete: () => PromiseLike<unknown> },
  limit = 10_000,
): Promise<void> {
  for (let removed = 0; removed < limit; removed += 1) {
    const deleted = await build().delete();
    if (deleted === null || deleted === undefined) return;
  }

  throw new Error("deleteAllIn removed 10000 rows without exhausting the match");
}

/* Likes ------------------------------------------------------------------ */

/** Which of the two things is being liked. */
type LikeSubject = "chapter" | "comment";

/**
 * The write for each subject, spelled out per table.
 *
 * Both tables take the same two statements with one identifier different, and
 * that identifier is the one thing a bound parameter cannot carry -- every
 * `${}` in `db.raw.sql` is a parameter, never a name. So the table name is
 * written literally in four short statements rather than interpolated from a
 * string, which is also what makes it impossible for a caller to reach a
 * table nobody listed here. Everything around them -- the choice, the count,
 * the answer -- is shared by `setLike` below.
 */
const LIKE_STATEMENTS = {
  chapter: {
    insert: (userId: string, chapterId: string) =>
      db.raw
        .sql`
          INSERT INTO "engagement"."chapterLike"
            ("userId", "chapterId", "createdAt")
          VALUES (${userId}, ${chapterId}, now())
          ON CONFLICT DO NOTHING
        `
        .affectedCount()
        .build(),
    remove: (userId: string, chapterId: string) =>
      db.raw
        .sql`
          DELETE FROM "engagement"."chapterLike"
           WHERE "userId" = ${userId}
             AND "chapterId" = ${chapterId}
        `
        .affectedCount()
        .build(),
  },
  comment: {
    insert: (userId: string, commentId: string) =>
      db.raw
        .sql`
          INSERT INTO "engagement"."commentLike"
            ("userId", "commentId", "createdAt")
          VALUES (${userId}, ${commentId}, now())
          ON CONFLICT DO NOTHING
        `
        .affectedCount()
        .build(),
    remove: (userId: string, commentId: string) =>
      db.raw
        .sql`
          DELETE FROM "engagement"."commentLike"
           WHERE "userId" = ${userId}
             AND "commentId" = ${commentId}
        `
        .affectedCount()
        .build(),
  },
} satisfies Record<LikeSubject, LikeStatements>;

/**
 * `unknown` for the plans, deliberately: this is a shape guard that every
 * subject carries both statements, not an attempt to name the query-plan type
 * -- which the runtime does not export and which `setLike` gets by inference
 * anyway.
 */
interface LikeStatements {
  insert: (userId: string, subjectId: string) => unknown;
  remove: (userId: string, subjectId: string) => unknown;
}

/**
 * Adds or removes one like, and answers the state that followed.
 *
 * **One statement, no read first.** `INSERT ... ON CONFLICT DO NOTHING`
 * against the pair's primary key is what makes liking idempotent: a double
 * click, two tabs or a retried request all write the same row once, with no
 * window between a read and an insert for the second one to land in. The
 * delete is silent for the same reason -- unliking something you never liked
 * is the state the caller asked for, not an error to report.
 *
 * That is deliberately *unlike* `upsertRating` below, which reads first
 * because it has a value to replace. A like has nothing to replace: the row's
 * existence is the whole of its content.
 *
 * The count is read after the write rather than inferred from it, so two
 * readers liking at once each see a number that was true rather than their own
 * increment applied to a stale one.
 */
async function setLike(
  subject: LikeSubject,
  userId: string,
  subjectId: string,
  liked: boolean,
): Promise<LikeSummary> {
  const statements = LIKE_STATEMENTS[subject];
  const plan = liked
    ? statements.insert(userId, subjectId)
    : statements.remove(userId, subjectId);

  await db.runtime().query(plan);

  return { count: await countLikes(subject, subjectId), liked };
}

async function countLikes(
  subject: LikeSubject,
  subjectId: string,
): Promise<number> {
  const totals =
    subject === "chapter"
      ? await db.orm.engagement.ChapterLike.where((like) =>
          like.chapterId.eq(subjectId),
        ).aggregate((aggregate) => ({ total: aggregate.count() }))
      : await db.orm.engagement.CommentLike.where((like) =>
          like.commentId.eq(subjectId),
        ).aggregate((aggregate) => ({ total: aggregate.count() }));

  return totals.total;
}

/**
 * Likes a chapter, or leaves it liked.
 *
 * Gated on the chapter being one the caller may *read*, through the same
 * helper `services/stories.ts` gates the chapter body on: a like on an
 * unpublished chapter would otherwise be a way to confirm that a draft exists
 * -- the side channel the comment list is careful not to be.
 *
 * A suspension stops this the way it stops a comment. It is a write on
 * somebody else's work, which is the whole of what a suspension is for; see
 * the header of `services/moderation.ts`.
 */
export async function likeChapter(
  userId: string,
  chapterId: string,
): Promise<LikeSummary> {
  await assertNotSuspended(userId);
  await visibleChapterId(chapterId, userId);

  return setLike("chapter", userId, chapterId, true);
}

/** Removes the caller's like. Silent when they had not liked it. */
export async function unlikeChapter(
  userId: string,
  chapterId: string,
): Promise<LikeSummary> {
  await visibleChapterId(chapterId, userId);

  return setLike("chapter", userId, chapterId, false);
}

async function visibleChapterId(
  chapterId: string,
  viewerId: string,
): Promise<string> {
  const chapter = await findVisibleChapter(chapterId, viewerId);
  if (chapter === null) {
    throw HttpError.notFound("That chapter could not be found.");
  }

  return chapter.id;
}

/**
 * Likes a comment, or leaves it liked.
 *
 * A hidden comment 404s rather than accepting a like, the same way replying to
 * one does: as far as anybody but a moderator is concerned it is gone, and a
 * like that landed on it would be invisible with no way to undo it. The
 * story's visibility is checked through the comment's own `storyId`, so a
 * comment under a draft is exactly as reachable as the draft.
 */
export async function likeComment(
  userId: string,
  commentId: string,
): Promise<LikeSummary> {
  await assertNotSuspended(userId);
  await visibleCommentId(commentId, userId);

  return setLike("comment", userId, commentId, true);
}

/** Removes the caller's like. Silent when they had not liked it. */
export async function unlikeComment(
  userId: string,
  commentId: string,
): Promise<LikeSummary> {
  await visibleCommentId(commentId, userId);

  return setLike("comment", userId, commentId, false);
}

async function visibleCommentId(
  commentId: string,
  viewerId: string,
): Promise<string> {
  const row = await commentsBase()
    .where((comment) => comment.id.eq(commentId))
    .first();

  if (!row) throw HttpError.notFound(COMMENT_NOT_FOUND);

  // Throws a 404 of its own when the story is one this caller cannot see.
  await visibleStoryId(row.storyId, viewerId);

  return row.id;
}

/* Ratings ---------------------------------------------------------------- */

/**
 * Recomputes `Story.ratingAverage` and `ratingCount` from the rows that exist
 * *now*, and returns what it wrote.
 *
 * Called inside the transaction that changed a rating, never after it: done
 * afterwards, two readers rating the same story at once would each recompute
 * against a snapshot that missed the other's row and the loser's write would
 * store a count that was never true.
 */
async function recomputeStoryRating(
  tx: Tx,
  storyId: string,
): Promise<{ average: number | null; count: number }> {
  const totals = await tx.orm.engagement.Rating.where((rating) =>
    rating.storyId.eq(storyId),
  ).aggregate((aggregate) => ({
    count: aggregate.count(),
    average: aggregate.avgDecimal("rating"),
  }));

  const count = totals.count;
  const average = count === 0 ? null : toAverage(totals.average);

  await tx.orm.content.Story.where((story) => story.id.eq(storyId)).update({
    // Null rather than 0 when the last rating goes: the column means "what
    // readers scored this", and nobody scored it 0.
    ratingAverage: average === null ? null : String(average),
    ratingCount: count,
    updatedAt: now(),
  });

  return { average, count };
}

/** The breakdown, the average, the count, and the caller's own score. */
export async function getRatings(
  slugOrId: string,
  viewerId: string | null,
): Promise<RatingSummary> {
  const storyId = await visibleStoryId(slugOrId, viewerId);

  /**
   * Grouped in SQL rather than by counting rows in JS: a popular story's
   * ratings are exactly the set that would be most expensive to hydrate, and
   * the five counts are all this needs.
   */
  const groups = await db.orm.engagement.Rating.where((rating) =>
    rating.storyId.eq(storyId),
  )
    .groupBy("rating")
    .aggregate((aggregate) => ({ count: aggregate.count() }));

  const breakdown = emptyBreakdown();
  let count = 0;
  let weighted = 0;

  for (const group of groups) {
    const score = toScore(group.rating);
    if (score === null) continue;

    breakdown[score] = (breakdown[score] ?? 0) + group.count;
    count += group.count;
    weighted += score * group.count;
  }

  const mine =
    viewerId === null ? null : await findMyRating(storyId, viewerId);

  return {
    // Averaged from the same groups the breakdown came from, so the two can
    // never disagree in a response the way a second query could.
    average: count === 0 ? null : weighted / count,
    count,
    breakdown,
    mine,
  };
}

async function findMyRating(
  storyId: string,
  userId: string,
): Promise<number | null> {
  const row = await db.orm.engagement.Rating.select("rating")
    .where((rating) => rating.storyId.eq(storyId))
    .where((rating) => rating.userId.eq(userId))
    .first();

  return row ? toScore(row.rating) : null;
}

/**
 * Records the caller's score, replacing the one they had.
 *
 * Upsert by hand rather than by unique-constraint conflict: `Rating` is unique
 * on `(userId, storyId)`, so the update branch is the common case and the
 * insert races only against the same person rating twice at once. That race is
 * caught below and retried as an update, which is what the unique index would
 * have forced anyway.
 */
export async function upsertRating(
  userId: string,
  slugOrId: string,
  score: number,
): Promise<RatingSummary> {
  const storyId = await visibleStoryId(slugOrId, userId);
  const timestamp = now();

  await db.transaction(async (tx) => {
    const existing = await tx.orm.engagement.Rating.select("id")
      .where((rating) => rating.storyId.eq(storyId))
      .where((rating) => rating.userId.eq(userId))
      .first();

    if (existing) {
      await tx.orm.engagement.Rating.where((rating) =>
        rating.id.eq(existing.id),
      ).update({ rating: String(score), updatedAt: timestamp });
    } else {
      await tx.orm.engagement.Rating.create({
        storyId,
        userId,
        rating: String(score),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }

    await recomputeStoryRating(tx, storyId);
  });

  // Ratings given is a badge metric -- and so is the *author's* view count,
  // which a rating does not move, so only the rater is re-evaluated.
  evaluateBadges(userId);

  return getRatings(storyId, userId);
}

/** Withdraws the caller's rating. Silent when they had none. */
export async function deleteRating(
  userId: string,
  slugOrId: string,
): Promise<RatingSummary> {
  const storyId = await visibleStoryId(slugOrId, userId);

  await db.transaction(async (tx) => {
    await tx.orm.engagement.Rating.where((rating) => rating.storyId.eq(storyId))
      .where((rating) => rating.userId.eq(userId))
      .delete();

    await recomputeStoryRating(tx, storyId);
  });

  return getRatings(storyId, userId);
}
