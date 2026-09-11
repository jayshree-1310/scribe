/**
 * Where each reader is in each story, and the reading streak that follows from
 * it.
 *
 * `engagement.ReadingHistory` is unique on `(userId, storyId)`, so it holds a
 * reader's *current position* in a story rather than a log of visits. That is
 * what makes "continue reading" one row per story with no dedupe pass, and
 * what the save below conflicts on.
 *
 * Every function takes the reader's id explicitly -- the routes resolve it once
 * through `middleware/current-user.ts` -- so nothing here reaches for ambient
 * request state and a position can never be read or written for the wrong user.
 */

import { Temporal } from "temporal-polyfill";
import { db } from "../prisma/db.js";
import { HttpError } from "../lib/http-error.js";
import { getStoriesByIds, toIso, type Story } from "./stories.js";

/* Shapes returned to the client ----------------------------------------- */

export interface ReadingProgress {
  storyId: string;
  chapterId: string | null;
  /** The chapter's reader-facing number, for building a resume link. */
  chapterNumber: number | null;
  /** Character offset into that chapter's text. See the contract's comment. */
  offset: number;
  /** Whole-story completion, 0-100. */
  percentComplete: number;
  lastReadAt: string;
}

/** A resume point with enough of its story attached to render a card. */
export interface ContinueEntry {
  progress: ReadingProgress;
  story: Story;
  /** Null when the chapter was deleted under the reader's feet. */
  chapter: { id: string; number: number; title: string } | null;
}

export interface ProgressInput {
  storyId: string;
  chapterId: string;
  /** Character offset into the chapter; clamped to the chapter's length. */
  offset: number;
}

export interface SavedProgress {
  progress: ReadingProgress;
  /** The reader's streak after this save, so the UI can reflect it at once. */
  readingStreak: number;
}

export const MAX_CONTINUE_LIMIT = 24;

/* The streak rule -------------------------------------------------------- */

export interface StreakOutcome {
  streak: number;
  /**
   * False when the day boundary has not moved, so the caller can skip the
   * write entirely rather than rewriting the same two values.
   */
  changed: boolean;
}

/** Milliseconds in a whole day, for the day-index arithmetic below. */
const DAY_MS = 86_400_000;

/**
 * Which whole day an instant falls in, as a day index that can be subtracted.
 *
 * **UTC, deliberately.** `auth.User` stores no timezone, so there is no
 * per-reader boundary to honour yet, and UTC is the only choice that gives
 * every reader the *same* boundary rather than one that follows whichever
 * server answered. A reader in UTC+13 therefore rolls over mid-afternoon,
 * which is wrong for them — the fix is a stored timezone, and when that column
 * lands it is passed in here, because this function is the only place in the
 * codebase that decides where a reading day starts.
 */
function dayIndex(instant: Date): number {
  return Math.floor(instant.getTime() / DAY_MS);
}

/**
 * The streak after a reading event at `now`, given the streak so far and the
 * event it was last advanced for.
 *
 * Pure, and the single definition of the rule: read on consecutive days and
 * the count grows, read twice in one day and nothing happens, miss a day and
 * it starts over at 1.
 *
 * A `previous` in the *future* — a clock that went backwards, or a row written
 * by a host whose time was wrong — is neither today nor yesterday and so
 * restarts the count. Restarting is the safe direction: it under-reports a
 * streak instead of inflating one, and the next consecutive day repairs it.
 */
export function advanceStreak(
  currentStreak: number,
  previous: Date | null,
  now: Date,
): StreakOutcome {
  if (previous === null) return { streak: 1, changed: true };

  const today = dayIndex(now);
  const last = dayIndex(previous);

  if (last === today) return { streak: currentStreak, changed: false };
  if (last === today - 1) return { streak: currentStreak + 1, changed: true };

  return { streak: 1, changed: true };
}

/* Scalar normalisation --------------------------------------------------- */

/** `lastReadAt` is never null in the contract, so a read always has a date. */
function requiredIso(value: unknown): string {
  return toIso(value) ?? new Date(0).toISOString();
}

/** Timestamp columns read and write `Temporal.Instant`. */
function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

interface HistoryRow {
  storyId: string;
  chapterId: string | null;
  offset: number;
  progress: number;
  lastReadAt: unknown;
}

function toProgress(
  row: HistoryRow,
  chapterNumber: number | null,
): ReadingProgress {
  return {
    storyId: row.storyId,
    chapterId: row.chapterId,
    chapterNumber,
    offset: row.offset,
    percentComplete: row.progress,
    lastReadAt: requiredIso(row.lastReadAt),
  };
}

/* Visibility ------------------------------------------------------------- */

const STORY_NOT_FOUND = "That story could not be found.";
const CHAPTER_NOT_FOUND = "That chapter could not be found.";

/**
 * The story, if this reader may see it at all.
 *
 * Same rule as `services/stories.ts`: anything listed, plus the caller's own
 * drafts. Repeated here against the narrow column set this module needs rather
 * than routing through `getStory`, which hydrates authors, genres and totals
 * that a progress write has no use for.
 */
async function visibleStory(
  storyId: string,
  userId: string,
): Promise<{ id: string; authorId: string }> {
  const row = await db.orm.content.Story.select("id", "authorId", "listedAt")
    .where((story) => story.id.eq(storyId))
    .first();

  if (!row) throw HttpError.notFound(STORY_NOT_FOUND);

  const listed = row.listedAt !== null && row.listedAt !== undefined;
  if (!listed && row.authorId !== userId) {
    throw HttpError.notFound(STORY_NOT_FOUND);
  }

  return { id: row.id, authorId: row.authorId };
}

/** Chapters of a story the reader may see: published, plus the author's own. */
function visibleChapters(storyId: string, isAuthor: boolean) {
  const chapters = db.orm.content.Chapter.where(
    (chapter) => chapter.storyId.eq(storyId),
  );

  return isAuthor
    ? chapters
    : chapters.where((chapter) => chapter.publishedAt.isNotNull());
}

/* Percent complete ------------------------------------------------------- */

/**
 * How far `offset` into `chapterNumber` is through the whole story, 0-100.
 *
 * Chapters are weighted by word count rather than counted, so a long chapter
 * moves the bar further than a short one — which is what a reader means by
 * "a third of the way through". The chapters considered are the ones the
 * reader can see, so an author previewing drafts and their audience get
 * different — and, for each of them, correct — denominators.
 */
function percentThrough(
  chapters: { number: number; words: number }[],
  chapterNumber: number,
  fractionThroughChapter: number,
): number {
  const total = chapters.reduce((sum, chapter) => sum + chapter.words, 0);

  // A story whose chapters all report zero words has no length to divide by,
  // so the current chapter is the whole of it.
  if (total === 0) return Math.round(fractionThroughChapter * 100);

  const before = chapters
    .filter((chapter) => chapter.number < chapterNumber)
    .reduce((sum, chapter) => sum + chapter.words, 0);

  const current =
    chapters.find((chapter) => chapter.number === chapterNumber)?.words ?? 0;

  const read = before + fractionThroughChapter * current;
  return Math.min(100, Math.max(0, Math.round((read / total) * 100)));
}

/* Writes ----------------------------------------------------------------- */

/**
 * Saves a resume point, and advances the reader's streak if the day moved.
 *
 * The reader calls this on every debounced scroll, so the row write is a
 * single `INSERT ... ON CONFLICT DO UPDATE` -- not a read followed by a write,
 * which would both cost two round trips and race two tabs of the same story
 * into a duplicate-key failure. The ORM in this version has no `upsert` and
 * the SQL builder emits no `ON CONFLICT`, so this goes through the client's
 * raw lane; interpolated values become bind parameters, not inlined text.
 */
export async function recordProgress(
  userId: string,
  input: ProgressInput,
): Promise<SavedProgress> {
  const story = await visibleStory(input.storyId, userId);
  const isAuthor = story.authorId === userId;

  const chapter = await visibleChapters(story.id, isAuthor)
    .select("id", "chapterNumber", "content")
    .where((row) => row.id.eq(input.chapterId))
    .first();

  if (!chapter) throw HttpError.notFound(CHAPTER_NOT_FOUND);

  const siblings = await visibleChapters(story.id, isAuthor)
    .select("chapterNumber", "wordCount")
    .all();

  // An offset past the end of the chapter is a rounding artefact of the
  // reader's scroll maths, not a bad request: clamp it rather than reject it.
  const length = chapter.content.length;
  const offset = Math.min(Math.max(0, input.offset), length);
  const fraction = length === 0 ? 0 : offset / length;

  const percentComplete = percentThrough(
    siblings.map((row) => ({ number: row.chapterNumber, words: row.wordCount })),
    chapter.chapterNumber,
    fraction,
  );

  const saved = await upsertProgress({
    userId,
    storyId: story.id,
    chapterId: chapter.id,
    offset,
    percentComplete,
  });

  const readingStreak = await recordStreak(userId);

  return {
    progress: toProgress(saved, chapter.chapterNumber),
    readingStreak,
  };
}

/**
 * The one-statement upsert behind `recordProgress`.
 *
 * `createdAt` is set only on insert -- `ON CONFLICT DO UPDATE` leaves out of
 * its `SET` list every column that should keep the row's original value -- so
 * "first opened" survives every later save.
 */
async function upsertProgress(input: {
  userId: string;
  storyId: string;
  chapterId: string;
  offset: number;
  percentComplete: number;
}): Promise<HistoryRow> {
  const plan = db.raw.sql`
    INSERT INTO "engagement"."readingHistory"
      ("id", "userId", "storyId", "chapterId", "offset", "progress",
       "lastReadAt", "createdAt", "updatedAt")
    VALUES
      (gen_random_uuid()::text, ${input.userId}, ${input.storyId},
       ${input.chapterId}, ${input.offset}, ${input.percentComplete},
       now(), now(), now())
    ON CONFLICT ("userId", "storyId") DO UPDATE SET
      "chapterId"  = EXCLUDED."chapterId",
      "offset"     = EXCLUDED."offset",
      "progress"   = EXCLUDED."progress",
      "lastReadAt" = EXCLUDED."lastReadAt",
      "updatedAt"  = EXCLUDED."updatedAt"
    RETURNING "storyId", "chapterId", "offset", "progress", "lastReadAt"
  `.returnsRow({
    storyId: "pg/text@1",
    chapterId: { codecId: "pg/text@1", nullable: true },
    offset: "pg/int4@1",
    progress: "pg/int4@1",
    lastReadAt: "pg/timestamptz-temporal@1",
  }).build();

  const [row] = await db.runtime().query(plan);
  if (!row) {
    // `ON CONFLICT DO UPDATE` always returns its row, so this cannot happen
    // without the statement above having been changed to `DO NOTHING`.
    throw new Error("progress upsert returned no row");
  }

  return row as HistoryRow;
}

/**
 * Advances `auth.User.readingStreak` for a reading event happening now, and
 * answers the streak the reader now has.
 *
 * Decided in `advanceStreak` and written under a compare-and-set on the anchor
 * it was decided from, so two saves racing across the same day boundary cannot
 * both increment: the loser's `WHERE` matches nothing and the count stays put.
 *
 * Not in a transaction with the position write above, because this client's
 * transaction context exposes no raw lane and so cannot carry the upsert. The
 * two are independent: a failure between them leaves the position saved and
 * the streak anchor untouched, which the reader's next save the same day
 * advances correctly.
 */
async function recordStreak(userId: string): Promise<number> {
  const user = await db.orm.auth.User.select("readingStreak", "streakLastReadAt")
    .where((row) => row.id.eq(userId))
    .first();

  if (!user) throw HttpError.unauthorized("Sign in to save your progress.");

  const previous = toDate(user.streakLastReadAt);
  const outcome = advanceStreak(user.readingStreak, previous, new Date());

  if (!outcome.changed) return outcome.streak;

  const guarded = db.orm.auth.User.where((row) => row.id.eq(userId));

  await (previous === null
    ? guarded.where((row) => row.streakLastReadAt.isNull())
    : guarded.where((row) =>
        row.streakLastReadAt.eq(Temporal.Instant.from(previous.toISOString())),
      )
  ).update({
    readingStreak: outcome.streak,
    streakLastReadAt: Temporal.Now.instant(),
    updatedAt: Temporal.Now.instant(),
  });

  return outcome.streak;
}

export async function clearProgress(
  userId: string,
  storyId: string,
): Promise<void> {
  const existing = await db.orm.engagement.ReadingHistory.select("id")
    .where((row) => row.userId.eq(userId))
    .where((row) => row.storyId.eq(storyId))
    .first();

  if (!existing) {
    throw HttpError.notFound("You have no saved position in that story.");
  }

  await db.orm.engagement.ReadingHistory.where((row) =>
    row.id.eq(existing.id),
  ).delete();
}

/* Reads ------------------------------------------------------------------ */

/** Reader-facing chapter numbers for a set of chapter ids. */
async function chapterNumbersByIds(
  chapterIds: string[],
): Promise<Map<string, { id: string; number: number; title: string }>> {
  if (chapterIds.length === 0) return new Map();

  const rows = await db.orm.content.Chapter.select(
    "id",
    "chapterNumber",
    "title",
  )
    .where((chapter) => chapter.id.in(chapterIds))
    .all();

  return new Map(
    rows.map((row) => [
      row.id,
      { id: row.id, number: row.chapterNumber, title: row.title },
    ]),
  );
}

/**
 * The reader's saved position in one story, or null when there is none.
 *
 * Null rather than 404 for a story with no saved position: "have I read this?"
 * is a question the reader page asks about every story it opens, and "no" is
 * an answer, not a failure.
 */
export async function getProgress(
  userId: string,
  storyId: string,
): Promise<ReadingProgress | null> {
  // Through the visibility check, so an unlisted draft does not answer for
  // anyone but its author even when they hold a row against it.
  await visibleStory(storyId, userId);

  const row = await db.orm.engagement.ReadingHistory.select(
    "storyId",
    "chapterId",
    "offset",
    "progress",
    "lastReadAt",
  )
    .where((entry) => entry.userId.eq(userId))
    .where((entry) => entry.storyId.eq(storyId))
    .first();

  if (!row) return null;

  const chapters = await chapterNumbersByIds(
    row.chapterId === null ? [] : [row.chapterId],
  );

  const chapter = row.chapterId === null ? undefined : chapters.get(row.chapterId);
  return toProgress(row as HistoryRow, chapter?.number ?? null);
}

/**
 * Most recently read stories first, each with its resume target.
 *
 * One row per story comes from the table's own unique pair rather than from a
 * `DISTINCT` here — see this module's header. A story the reader may no longer
 * see drops out of the list rather than failing it.
 */
export async function listContinueReading(
  userId: string,
  limit: number,
): Promise<ContinueEntry[]> {
  const rows = await db.orm.engagement.ReadingHistory.select(
    "storyId",
    "chapterId",
    "offset",
    "progress",
    "lastReadAt",
  )
    .where((entry) => entry.userId.eq(userId))
    // `id` breaks the tie, so two positions saved in the same millisecond
    // still come back in a stable order across requests.
    .orderBy([(entry) => entry.lastReadAt.desc(), (entry) => entry.id.desc()])
    .limit(limit)
    .all();

  if (rows.length === 0) return [];

  const chapterIds = rows
    .map((row) => row.chapterId)
    .filter((id): id is string => id !== null);

  const [stories, chapters] = await Promise.all([
    getStoriesByIds(
      rows.map((row) => row.storyId),
      userId,
    ),
    chapterNumbersByIds(chapterIds),
  ]);

  return rows
    .map((row) => {
      const story = stories.get(row.storyId);
      if (!story) return null;

      const chapter =
        row.chapterId === null ? null : chapters.get(row.chapterId) ?? null;

      return {
        progress: toProgress(row as HistoryRow, chapter?.number ?? null),
        story,
        chapter,
      };
    })
    .filter((entry): entry is ContinueEntry => entry !== null);
}
