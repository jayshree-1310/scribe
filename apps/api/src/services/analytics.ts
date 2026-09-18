/**
 * Author analytics: the event log, and the figures read back off it.
 *
 * Two things are decided here and nowhere else.
 *
 * - **What is recorded, and at what grain.** A story view and a chapter read,
 *   one row per visitor per target per UTC day. The grain is the dedupe rule
 *   and it is enforced by the unique key on the table, not by a read-then-write
 *   in this file: a refresh, a back button and a second tab all conflict on it
 *   and insert nothing, with no race to lose. See `engagement.StoryView` in the
 *   contract for why `day` is a stored text column.
 * - **What a range means.** `7d` is today and the six days before it, in UTC,
 *   decided by the database's own clock. Every series has exactly as many
 *   points as the range has days, zeroes included -- a chart with a missing
 *   Tuesday is a lie about Tuesday, not an absence of data.
 *
 * Writes are fire-and-forget by construction: `recordStoryView` and
 * `recordChapterRead` return `void`, so a handler *cannot* await one, and they
 * swallow their own failures into the log. A reader must never wait on, or be
 * shown an error from, a counter.
 *
 * Every read aggregates in SQL. An author with a year of traffic is a large
 * number of rows and a small number of numbers; pulling the rows into JS to
 * count them would be the one thing this file must not do.
 */

import { createHash } from "node:crypto";
import { db } from "../prisma/db.js";
import { HttpError } from "../lib/http-error.js";
import { logger } from "../lib/logger.js";
import { toIso, type StoryStatus } from "./stories.js";

/* Shapes returned to the client ------------------------------------------ */

export const ANALYTICS_RANGES = ["7d", "30d", "90d"] as const;

export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

/** Days each range covers, today included. */
const RANGE_DAYS: Record<AnalyticsRange, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

/** One day of the chart. Matches `components/charts/LineChart.tsx`'s point. */
export interface SeriesPoint {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  views: number;
  reads: number;
}

/** Everything that happened inside the requested window. */
export interface RangeTotals {
  views: number;
  reads: number;
  /**
   * Distinct visitors across both event kinds -- not views plus reads. One
   * person who opened a story and four of its chapters is one reader here and
   * five events above.
   */
  readers: number;
  comments: number;
  ratings: number;
}

/** Everything the author has ever accumulated, across every story. */
export interface LifetimeTotals {
  /** Drafts included: this is what the author has, not what readers see. */
  stories: number;
  published: number;
  chapters: number;
  words: number;
  /**
   * `content.Story.viewCount` summed. That column carries whatever a seeded
   * story was imported with *plus* every deduped view recorded since, so it
   * can legitimately dwarf the range figure above, which starts at the day the
   * event log did.
   */
  views: number;
  likes: number;
  ratings: number;
  /** Weighted across the author's rated stories, or null if none are rated. */
  ratingAverage: number | null;
}

/** One story, its lifetime counters and what it did inside the range. */
export interface StoryPerformance {
  id: string;
  slug: string;
  title: string;
  coverUrl: string | null;
  status: StoryStatus;
  /** Every chapter, published or not: the caller is always the author here. */
  chapterCount: number;
  wordCount: number;
  updatedAt: string;
  /**
   * The primary genre's hue, or the default when the story has no genres.
   *
   * One number rather than the whole genre list, because the only thing these
   * pages do with a genre is draw a cover in its colour -- and the primary is
   * the alphabetically first, matching how `services/stories.ts` sorts the
   * list the reader-facing cover picks from.
   */
  hue: number;
  lifetimeViews: number;
  likeCount: number;
  ratingCount: number;
  ratingAverage: number | null;
  views: number;
  reads: number;
  readers: number;
}

/** One chapter's share of a story's reads. */
export interface ChapterPerformance {
  id: string;
  number: number;
  title: string;
  wordCount: number;
  published: boolean;
  reads: number;
  readers: number;
}

interface RangeWindow {
  range: AnalyticsRange;
  /** First day counted, `YYYY-MM-DD` inclusive. */
  from: string;
  /** Last day counted -- today in UTC -- inclusive. */
  to: string;
}

export interface AuthorOverview extends RangeWindow {
  totals: RangeTotals;
  lifetime: LifetimeTotals;
  series: SeriesPoint[];
  /** Every story the author has, most viewed in the range first. */
  stories: StoryPerformance[];
}

export interface StoryAnalytics extends RangeWindow {
  story: StoryPerformance;
  series: SeriesPoint[];
  chapters: ChapterPerformance[];
}

/* Recording -------------------------------------------------------------- */

/**
 * Who is looking, as far as a counter needs to know.
 *
 * Built by the route because only the route has the request. `userId` is the
 * signed-in reader or null; `key` is what the dedupe is per.
 */
export interface Visitor {
  userId: string | null;
  key: string;
}

/**
 * Domain-separated salt for the anonymous digest below.
 *
 * `ANALYTICS_SALT` if it is set, otherwise derived from the access-token
 * secret, which `lib/jwt.ts` already insists exists. Derived rather than used
 * directly: hashing a signing key with a purpose string means the value that
 * salts an analytics digest is not the value that signs a token, so neither
 * can be learned from the other. The digest is one-way and never leaves the
 * database, so this is a reasonable stand-in for a dedicated secret -- but a
 * dedicated one is one line in `.env`.
 */
function salt(): string {
  const configured = process.env["ANALYTICS_SALT"];
  if (configured) return configured;

  return createHash("sha256")
    .update(`scribe-analytics:${process.env["JWT_ACCESS_SECRET"] ?? ""}`)
    .digest("hex");
}

/**
 * The dedupe subject for a request.
 *
 * A signed-in reader is themselves. A signed-out one is a digest of their
 * address and user agent **salted with the day**, so the same visitor is one
 * visitor for as long as the day lasts and is not the same anybody tomorrow.
 * That is the point: a stable digest of an address would be a pseudonymous
 * tracker sitting in the database, and there is nothing analytics needs it
 * for. Most readers are signed out, so refusing to count them at all would be
 * wrong by roughly the same margin every day rather than not wrong.
 *
 * The day here is the *app's* UTC day while the row's `day` column is the
 * *database's*. In the second they disagree a visitor can land twice, once on
 * each side of midnight, which is one extra view per visitor per year.
 * Recomputing the digest in SQL is the only way to close it, and a digest is
 * not something SQL should be computing.
 */
export function visitorFor(request: {
  userId: string | null;
  ip: string | undefined;
  userAgent: string | undefined;
}): Visitor {
  if (request.userId) {
    return { userId: request.userId, key: `user:${request.userId}` };
  }

  const today = new Date().toISOString().slice(0, 10);
  const digest = createHash("sha256")
    .update(
      [salt(), today, request.ip ?? "unknown", request.userAgent ?? ""].join(
        "\u0000",
      ),
    )
    .digest("base64url")
    .slice(0, 32);

  return { userId: null, key: `anon:${digest}` };
}

/**
 * In-flight recording writes.
 *
 * Fire-and-forget has no seam a caller can wait on, and two callers genuinely
 * need one: a test that asserts a request recorded something, and a shutdown
 * that should not drop a write already issued. `flushAnalytics` is that seam.
 */
const pending = new Set<Promise<unknown>>();

function fireAndForget(work: Promise<unknown>, context: object): void {
  const tracked = work.catch((error: unknown) => {
    // A counter is never worth a failed read. Logged at warn so a broken
    // recorder is visible without being paged on.
    logger.warn({ err: error, ...context }, "analytics: event not recorded");
  });

  pending.add(tracked);
  void tracked.finally(() => pending.delete(tracked));
}

/** Settles every recording write issued so far. */
export async function flushAnalytics(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}

/**
 * Records that somebody opened a story, and moves the story's lifetime
 * counter in the same statement.
 *
 * Written as one `INSERT ... SELECT` rather than a read followed by a write,
 * which buys three things: a story that has since been deleted inserts nothing
 * instead of breaching a foreign key, the author's own visit is excluded by
 * the same `WHERE` rather than by a second round trip, and `viewCount` moves
 * only when the insert actually happened -- so a refresh does not inflate the
 * counter any more than it inflates the log.
 *
 * An author does not count as a reader of their own story. Without that an
 * author refining a chapter would be most of their own audience, and the
 * number they are being shown is meant to be about somebody else.
 */
export function recordStoryView(storyId: string, visitor: Visitor): void {
  fireAndForget(insertStoryView(storyId, visitor), { storyId });
}

async function insertStoryView(
  storyId: string,
  visitor: Visitor,
): Promise<void> {
  // The empty string stands in for "anonymous" so the bind stays a plain text
  // parameter; `NULLIF` turns it back into the NULL the column wants.
  const viewer = visitor.userId ?? "";

  const plan = db.raw.sql`
    WITH recorded AS (
      INSERT INTO "engagement"."storyView"
        ("id", "storyId", "userId", "visitorKey", "day", "createdAt")
      SELECT gen_random_uuid()::text,
             s."id",
             NULLIF(${viewer}::text, ''),
             ${visitor.key},
             to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
             now()
        FROM "content"."story" AS s
       WHERE s."id" = ${storyId}
         AND s."authorId" IS DISTINCT FROM NULLIF(${viewer}::text, '')
      ON CONFLICT ("storyId", "visitorKey", "day") DO NOTHING
      RETURNING "storyId"
    )
    UPDATE "content"."story" AS s
       SET "viewCount" = s."viewCount" + 1
      FROM recorded
     WHERE s."id" = recorded."storyId"
  `.affectedCount().build();

  await db.runtime().query(plan);
}

/**
 * Records that somebody opened a chapter.
 *
 * `storyId` is taken from the chapter row rather than from the caller, so the
 * denormalised column cannot disagree with the chapter it belongs to. No
 * lifetime counter moves: there is no chapter-read column on the story, and
 * inventing one would be a second answer to a question the log already
 * answers.
 */
export function recordChapterRead(chapterId: string, visitor: Visitor): void {
  fireAndForget(insertChapterRead(chapterId, visitor), { chapterId });
}

async function insertChapterRead(
  chapterId: string,
  visitor: Visitor,
): Promise<void> {
  const viewer = visitor.userId ?? "";

  const plan = db.raw.sql`
    INSERT INTO "engagement"."chapterRead"
      ("id", "storyId", "chapterId", "userId", "visitorKey", "day", "createdAt")
    SELECT gen_random_uuid()::text,
           c."storyId",
           c."id",
           NULLIF(${viewer}::text, ''),
           ${visitor.key},
           to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
           now()
      FROM "content"."chapter" AS c
      JOIN "content"."story" AS s ON s."id" = c."storyId"
     WHERE c."id" = ${chapterId}
       AND s."authorId" IS DISTINCT FROM NULLIF(${viewer}::text, '')
    ON CONFLICT ("chapterId", "visitorKey", "day") DO NOTHING
  `.affectedCount().build();

  await db.runtime().query(plan);
}

/* Reading ---------------------------------------------------------------- */

/**
 * The window, resolved against the database's clock rather than this
 * process's.
 *
 * Every other timestamp on these rows is written by Postgres, and the
 * challenges service already carries a documented gap from judging a window in
 * the app instead. One round trip is cheaper than that gap.
 */
async function windowFor(range: AnalyticsRange): Promise<RangeWindow> {
  const days = RANGE_DAYS[range];

  const plan = db.raw.sql`
    SELECT to_char((now() AT TIME ZONE 'UTC')::date - (${days}::int - 1),
                   'YYYY-MM-DD') AS "from",
           to_char((now() AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS "to"
  `.returnsRow({ from: "pg/text@1", to: "pg/text@1" }).build();

  const [row] = (await db.runtime().query(plan)) as { from: string; to: string }[];
  if (!row) throw new Error("analytics window query returned no row");

  return { range, from: row.from, to: row.to };
}

/**
 * The daily series for a set of stories, gaps filled.
 *
 * `generate_series` supplies the days and the event tables are left-joined
 * onto them, so a day with no traffic is a zero rather than a missing point --
 * and a story with no events at all is a full run of zeroes rather than an
 * empty array the chart would have to guess at.
 */
interface SeriesRow {
  date: string;
  views: number;
  reads: number;
}

async function series(
  window: RangeWindow,
  scope: { authorId: string } | { storyId: string },
): Promise<SeriesPoint[]> {
  /**
   * `source = SCRIBE` everywhere an author's whole body of work is gathered,
   * the same filter `countVisibleStoriesBy` applies and for the same reason: a
   * seeded catalogue edition carries a real author column, and nobody wrote it
   * here. Narrowing to one story skips it -- the caller's ownership of that
   * story has already been established by `performance`.
   */
  const authorId = "authorId" in scope ? scope.authorId : "";
  const storyId = "storyId" in scope ? scope.storyId : "";

  const plan = db.raw.sql`
    WITH mine AS (
      SELECT s."id"
        FROM "content"."story" AS s
       WHERE (${authorId}::text <> ''
              AND s."authorId" = ${authorId}
              AND s."source" = 'SCRIBE')
          OR (${storyId}::text <> '' AND s."id" = ${storyId})
    ),
    days AS (
      SELECT to_char(day::date, 'YYYY-MM-DD') AS "day"
        FROM generate_series(${window.from}::date, ${window.to}::date,
                             interval '1 day') AS day
    ),
    views AS (
      SELECT v."day", COUNT(*)::int AS "count"
        FROM "engagement"."storyView" AS v
        JOIN mine ON mine."id" = v."storyId"
       WHERE v."day" >= ${window.from} AND v."day" <= ${window.to}
       GROUP BY v."day"
    ),
    reads AS (
      SELECT r."day", COUNT(*)::int AS "count"
        FROM "engagement"."chapterRead" AS r
        JOIN mine ON mine."id" = r."storyId"
       WHERE r."day" >= ${window.from} AND r."day" <= ${window.to}
       GROUP BY r."day"
    )
    SELECT days."day"                       AS "date",
           COALESCE(views."count", 0)::int  AS "views",
           COALESCE(reads."count", 0)::int  AS "reads"
      FROM days
      LEFT JOIN views ON views."day" = days."day"
      LEFT JOIN reads ON reads."day" = days."day"
     ORDER BY days."day" ASC
  `.returnsRow({
    date: "pg/text@1",
    views: "pg/int4@1",
    reads: "pg/int4@1",
  }).build();

  return (await db.runtime().query(plan)) as SeriesRow[];
}

/**
 * What happened to an author's work inside the window.
 *
 * The two event tables are unioned before they are counted so `readers` can be
 * a `COUNT(DISTINCT …)` over both: somebody who opened a story and four of its
 * chapters is one reader, and two separate counts could never be added into
 * that answer. Comments and ratings are counted by `createdAt` against the
 * same day boundary, which is what makes them comparable to the rest.
 */
async function rangeTotals(
  window: RangeWindow,
  authorId: string,
): Promise<RangeTotals> {
  const plan = db.raw.sql`
    WITH mine AS (
      SELECT s."id"
        FROM "content"."story" AS s
       WHERE s."authorId" = ${authorId}
         AND s."source" = 'SCRIBE'
    ),
    events AS (
      SELECT v."visitorKey", 1 AS "isView", 0 AS "isRead"
        FROM "engagement"."storyView" AS v
        JOIN mine ON mine."id" = v."storyId"
       WHERE v."day" >= ${window.from} AND v."day" <= ${window.to}
      UNION ALL
      SELECT r."visitorKey", 0, 1
        FROM "engagement"."chapterRead" AS r
        JOIN mine ON mine."id" = r."storyId"
       WHERE r."day" >= ${window.from} AND r."day" <= ${window.to}
    )
    SELECT (SELECT COALESCE(SUM("isView"), 0) FROM events)::int         AS "views",
           (SELECT COALESCE(SUM("isRead"), 0) FROM events)::int         AS "reads",
           (SELECT COUNT(DISTINCT "visitorKey") FROM events)::int       AS "readers",
           (SELECT COUNT(*)
              FROM "engagement"."comment" AS c
              JOIN mine ON mine."id" = c."storyId"
             WHERE c."createdAt" >= (${window.from}::date) AT TIME ZONE 'UTC'
               AND c."createdAt" <  ((${window.to}::date) + 1) AT TIME ZONE 'UTC'
               -- A comment a moderator hid is not engagement the author
               -- received. See services/moderation.ts.
               AND c."hiddenAt" IS NULL
           )::int                                                        AS "comments",
           (SELECT COUNT(*)
              FROM "engagement"."rating" AS t
              JOIN mine ON mine."id" = t."storyId"
             WHERE t."createdAt" >= (${window.from}::date) AT TIME ZONE 'UTC'
               AND t."createdAt" <  ((${window.to}::date) + 1) AT TIME ZONE 'UTC'
           )::int                                                        AS "ratings"
  `.returnsRow({
    views: "pg/int4@1",
    reads: "pg/int4@1",
    readers: "pg/int4@1",
    comments: "pg/int4@1",
    ratings: "pg/int4@1",
  }).build();

  const [row] = (await db.runtime().query(plan)) as RangeTotals[];

  return row ?? { views: 0, reads: 0, readers: 0, comments: 0, ratings: 0 };
}

/**
 * Lifetime figures, summed over the story rows rather than over the log.
 *
 * `ratingAverage` is weighted by `ratingCount` -- the mean of the per-story
 * means would let a story with one rating count as much as one with a
 * thousand, which is the same mistake the challenge board's ranking rule
 * refuses to make.
 */
interface LifetimeRow {
  stories: number;
  published: number;
  chapters: number;
  words: number;
  views: number;
  likes: number;
  ratings: number;
  ratingTotal: unknown;
}

async function lifetimeTotals(authorId: string): Promise<LifetimeTotals> {
  const plan = db.raw.sql`
    WITH mine AS (
      SELECT s."id", s."listedAt", s."viewCount", s."likeCount",
             s."ratingCount", s."ratingAverage"
        FROM "content"."story" AS s
       WHERE s."authorId" = ${authorId}
         AND s."source" = 'SCRIBE'
    )
    SELECT (SELECT COUNT(*) FROM mine)::int                             AS "stories",
           (SELECT COUNT(*) FROM mine WHERE "listedAt" IS NOT NULL)::int AS "published",
           (SELECT COUNT(*)
              FROM "content"."chapter" AS c
              JOIN mine ON mine."id" = c."storyId")::int                 AS "chapters",
           (SELECT COALESCE(SUM(c."wordCount"), 0)
              FROM "content"."chapter" AS c
              JOIN mine ON mine."id" = c."storyId")::int                 AS "words",
           (SELECT COALESCE(SUM("viewCount"), 0) FROM mine)::int         AS "views",
           (SELECT COALESCE(SUM("likeCount"), 0) FROM mine)::int         AS "likes",
           (SELECT COALESCE(SUM("ratingCount"), 0) FROM mine)::int       AS "ratings",
           (SELECT COALESCE(SUM("ratingAverage" * "ratingCount"), 0)
              FROM mine WHERE "ratingAverage" IS NOT NULL)               AS "ratingTotal"
  `.returnsRow({
    stories: "pg/int4@1",
    published: "pg/int4@1",
    chapters: "pg/int4@1",
    words: "pg/int4@1",
    views: "pg/int4@1",
    likes: "pg/int4@1",
    ratings: "pg/int4@1",
    ratingTotal: "pg/numeric@1",
  }).build();

  const [row] = (await db.runtime().query(plan)) as LifetimeRow[];

  if (!row) {
    return {
      stories: 0,
      published: 0,
      chapters: 0,
      words: 0,
      views: 0,
      likes: 0,
      ratings: 0,
      ratingAverage: null,
    };
  }

  const ratingTotal = Number(row.ratingTotal ?? 0);

  return {
    stories: row.stories,
    published: row.published,
    chapters: row.chapters,
    words: row.words,
    views: row.views,
    likes: row.likes,
    ratings: row.ratings,
    ratingAverage: row.ratings > 0 ? ratingTotal / row.ratings : null,
  };
}

/**
 * Per-story rows: the story's own columns, plus what it did in the window.
 *
 * One lateral per story rather than a grouped join across both event tables,
 * because the two grains would multiply against each other -- a story with
 * three views and four reads would report twelve of each. An author has tens
 * of stories, so the lateral runs tens of times over indexed columns.
 *
 * `storyId` narrows it to one story, for the detail endpoint; otherwise every
 * story the author has, drafts included, because a draft's analytics page is
 * how an author checks nobody can see it yet.
 */
interface PerformanceRow {
  id: string;
  slug: string;
  title: string;
  coverUrl: string | null;
  listedAt: unknown;
  isCompleted: boolean;
  updatedAt: unknown;
  hue: number;
  lifetimeViews: number;
  likeCount: number;
  ratingCount: number;
  ratingAverage: unknown;
  chapterCount: number;
  wordCount: number;
  views: number;
  reads: number;
  readers: number;
}

function toPerformance(row: PerformanceRow): StoryPerformance {
  const listedAt = toIso(row.listedAt);
  const average =
    row.ratingAverage === null || row.ratingAverage === undefined
      ? null
      : Number(row.ratingAverage);

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    coverUrl: row.coverUrl,
    // The same three-way rule `services/stories.ts` applies, so the badge on
    // this page and the badge on the story page cannot disagree.
    status: listedAt === null ? "draft" : row.isCompleted ? "completed" : "ongoing",
    chapterCount: row.chapterCount,
    wordCount: row.wordCount,
    updatedAt: toIso(row.updatedAt) ?? new Date(0).toISOString(),
    hue: row.hue,
    lifetimeViews: row.lifetimeViews,
    likeCount: row.likeCount,
    ratingCount: row.ratingCount,
    ratingAverage: average !== null && Number.isFinite(average) ? average : null,
    views: row.views,
    reads: row.reads,
    readers: row.readers,
  };
}

async function performance(
  window: RangeWindow,
  scope: { authorId: string; storyId?: string },
): Promise<StoryPerformance[]> {
  const storyId = scope.storyId ?? "";

  const plan = db.raw.sql`
    SELECT s."id", s."slug", s."title", s."coverUrl", s."listedAt",
           s."isCompleted", s."updatedAt",
           COALESCE(genre."hue", 268)::int AS "hue",
           s."viewCount"     AS "lifetimeViews",
           s."likeCount", s."ratingCount", s."ratingAverage",
           ch."chapterCount", ch."wordCount",
           agg."views", agg."reads", agg."readers"
      FROM "content"."story" AS s
      LEFT JOIN LATERAL (
            SELECT g."hue"
              FROM "content"."storyGenre" AS sg
              JOIN "content"."genre" AS g ON g."id" = sg."genreId"
             WHERE sg."storyId" = s."id"
             ORDER BY g."name" ASC
             LIMIT 1
           ) AS genre ON TRUE
      CROSS JOIN LATERAL (
            SELECT COUNT(*)::int                             AS "chapterCount",
                   COALESCE(SUM(c."wordCount"), 0)::int      AS "wordCount"
              FROM "content"."chapter" AS c
             WHERE c."storyId" = s."id"
           ) AS ch
      CROSS JOIN LATERAL (
            SELECT COUNT(*) FILTER (WHERE e."kind" = 'view')::int AS "views",
                   COUNT(*) FILTER (WHERE e."kind" = 'read')::int AS "reads",
                   COUNT(DISTINCT e."visitorKey")::int            AS "readers"
              FROM (
                    SELECT 'view' AS "kind", v."visitorKey"
                      FROM "engagement"."storyView" AS v
                     WHERE v."storyId" = s."id"
                       AND v."day" >= ${window.from} AND v."day" <= ${window.to}
                    UNION ALL
                    SELECT 'read', r."visitorKey"
                      FROM "engagement"."chapterRead" AS r
                     WHERE r."storyId" = s."id"
                       AND r."day" >= ${window.from} AND r."day" <= ${window.to}
                   ) AS e
           ) AS agg
     WHERE s."authorId" = ${scope.authorId}
       AND s."source" = 'SCRIBE'
       AND (${storyId}::text = '' OR s."id" = ${storyId})
     ORDER BY agg."views" DESC, s."viewCount" DESC, s."updatedAt" DESC, s."id" ASC
  `.returnsRow({
    id: "pg/text@1",
    slug: "pg/text@1",
    title: "pg/text@1",
    coverUrl: { codecId: "pg/text@1", nullable: true },
    listedAt: { codecId: "pg/timestamptz-temporal@1", nullable: true },
    isCompleted: "pg/bool@1",
    updatedAt: "pg/timestamptz-temporal@1",
    hue: "pg/int4@1",
    lifetimeViews: "pg/int4@1",
    likeCount: "pg/int4@1",
    ratingCount: "pg/int4@1",
    ratingAverage: { codecId: "pg/numeric@1", nullable: true },
    chapterCount: "pg/int4@1",
    wordCount: "pg/int4@1",
    views: "pg/int4@1",
    reads: "pg/int4@1",
    readers: "pg/int4@1",
  }).build();

  const rows = (await db.runtime().query(plan)) as PerformanceRow[];
  return rows.map(toPerformance);
}

/** Reads within one story, per chapter, in reading order. */
interface ChapterRow {
  id: string;
  chapterNumber: number;
  title: string;
  wordCount: number;
  publishedAt: unknown;
  reads: number;
  readers: number;
}

async function chapterBreakdown(
  window: RangeWindow,
  storyId: string,
): Promise<ChapterPerformance[]> {
  const plan = db.raw.sql`
    SELECT c."id", c."chapterNumber", c."title", c."wordCount", c."publishedAt",
           agg."reads", agg."readers"
      FROM "content"."chapter" AS c
      CROSS JOIN LATERAL (
            SELECT COUNT(*)::int                      AS "reads",
                   COUNT(DISTINCT r."visitorKey")::int AS "readers"
              FROM "engagement"."chapterRead" AS r
             WHERE r."chapterId" = c."id"
               AND r."day" >= ${window.from} AND r."day" <= ${window.to}
           ) AS agg
     WHERE c."storyId" = ${storyId}
     ORDER BY c."chapterNumber" ASC
  `.returnsRow({
    id: "pg/text@1",
    chapterNumber: "pg/int4@1",
    title: "pg/text@1",
    wordCount: "pg/int4@1",
    publishedAt: { codecId: "pg/timestamptz-temporal@1", nullable: true },
    reads: "pg/int4@1",
    readers: "pg/int4@1",
  }).build();

  const rows = (await db.runtime().query(plan)) as ChapterRow[];

  return rows.map((row) => ({
    id: row.id,
    number: row.chapterNumber,
    title: row.title,
    wordCount: row.wordCount,
    published: row.publishedAt !== null && row.publishedAt !== undefined,
    reads: row.reads,
    readers: row.readers,
  }));
}

/* Endpoints -------------------------------------------------------------- */

/**
 * Everything both author pages need, in one request.
 *
 * Deliberately not assembled from `listStories` the way those pages used to
 * do it: a page of forty-eight stories summed in the browser is neither every
 * story nor an aggregate, and it cannot answer a per-day question at all.
 */
export async function getAuthorOverview(
  authorId: string,
  range: AnalyticsRange,
): Promise<AuthorOverview> {
  const window = await windowFor(range);

  const [totals, lifetime, points, stories] = await Promise.all([
    rangeTotals(window, authorId),
    lifetimeTotals(authorId),
    series(window, { authorId }),
    performance(window, { authorId }),
  ]);

  return { ...window, totals, lifetime, series: points, stories };
}

/**
 * One story's breakdown.
 *
 * 404 rather than 403 when the story belongs to somebody else: the caller is
 * asking for *their* analytics on it, and they have none. Answering
 * "forbidden" would confirm the id names a real story, which an author
 * enumerating ids has no business learning.
 */
export async function getStoryAnalytics(
  authorId: string,
  storyId: string,
  range: AnalyticsRange,
): Promise<StoryAnalytics> {
  const window = await windowFor(range);

  const [story] = await performance(window, { authorId, storyId });
  if (!story) throw HttpError.notFound("That story could not be found.");

  const [points, chapters] = await Promise.all([
    series(window, { storyId }),
    chapterBreakdown(window, storyId),
  ]);

  return { ...window, story, series: points, chapters };
}
