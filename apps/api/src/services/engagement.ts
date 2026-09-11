/**
 * Comments and ratings on stories.
 *
 * Comments follow the thread shape `services/clubs.ts` established and
 * `services/channels.ts` followed, deliberately rather than inventing a third:
 * one table for threads and replies told apart by a nullable `parentId`,
 * replies capped at one level deep, a `Page<T>` ordered newest-first with `id`
 * as the tie-breaker, and an author summary of exactly four fields. Moderation
 * (Task 15) then has one read path per surface to audit instead of three.
 *
 * The one place this diverges from clubs is who may delete. A club resolves
 * "moderator" from a membership row; a story has no membership table, so there
 * is no moderator to resolve and delete is the comment's author alone. The
 * story's author is deliberately *not* given the power here -- that is a
 * moderation rule, and Task 15 owns the role decision that would justify it.
 *
 * Ratings keep `content.Story.ratingAverage` and `ratingCount` in step inside
 * the same transaction as every write. Those columns are not the read path --
 * `services/stories.ts` computes both from `Rating` rows -- but `sort=rating`
 * orders in SQL over the story table, so a stale column silently mis-sorts the
 * catalogue.
 *
 * Every function takes the caller's id explicitly -- the routes resolve it
 * once through `middleware/current-user.ts` -- so nothing here reaches for
 * ambient request state.
 */

import { Temporal } from "temporal-polyfill";
import { db } from "../prisma/db.js";
import { HttpError } from "../lib/http-error.js";
import { findVisibleStoryId, toIso } from "./stories.js";

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
  );
}

async function hydrateComments(
  rows: CommentRow[],
  withReplyCounts: boolean,
): Promise<Comment[]> {
  if (rows.length === 0) return [];

  const users = await usersByIds(rows.map((row) => row.userId));

  const replyCounts = new Map<string, number>();
  if (withReplyCounts) {
    // One query for the whole page's replies rather than one per thread.
    const replies = await db.orm.engagement.Comment.select("parentId")
      .where((row) => row.parentId.in(rows.map((thread) => thread.id)))
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

  const items = await hydrateComments(rows as CommentRow[], threads);
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

  const [comment] = await hydrateComments([row as CommentRow], true);
  if (!comment) throw HttpError.notFound(COMMENT_NOT_FOUND);

  return comment;
}

/**
 * Deletes a thread or a reply. Its author alone -- see the module header for
 * why there is no moderator branch here yet.
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
