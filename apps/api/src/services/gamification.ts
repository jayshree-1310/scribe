/**
 * Badges and levels: the catalogue, the metrics behind it, and the award
 * engine.
 *
 * Four things are decided here and nowhere else.
 *
 * - **The catalogue is a table of data, not a table in the database.** Every
 *   badge is one `BadgeDefinition` in `BADGES` below, and adding one is a row
 *   in that array. There is no `gamification.Badge` model any more -- see the
 *   header of `gamification.UserBadge` in the contract for why a second copy
 *   of this list, synced by something, would only ever be the wrong one.
 * - **A badge is a metric and a threshold, never a bespoke rule.** A
 *   definition names one of `BADGE_METRICS` and the number that earns it, so
 *   `evaluateBadges` has exactly one comparison in it and a new badge cannot
 *   introduce a new code path. What a metric *is* lives in `metricsFor`, in
 *   SQL, for the reason `services/analytics.ts` gives: a reader with four
 *   thousand chapter reads is a large number of rows and a small number of
 *   numbers.
 * - **Awarding is idempotent by construction.** The insert conflicts on
 *   `(userId, code)` and returns nothing when the row is already there, so
 *   "have they got it?" is never a read followed by a write that two requests
 *   can lose. Re-evaluating a reader who has earned everything writes nothing
 *   and returns an empty array.
 * - **Levels are derived, not accumulated.** `readerLevel` and `authorLevel`
 *   are a lookup of one metric against a fixed ladder (`READER_LADDER`,
 *   `AUTHOR_LADDER`), recomputed from scratch on every evaluation. A level
 *   that was incremented by events would drift the first time an event was
 *   missed or replayed; this one cannot, because nothing about today's value
 *   depends on the path taken to it. The columns exist only so a profile can
 *   be read without recomputing.
 *
 * `evaluateBadges` is fire-and-forget by the same construction
 * `recordStoryView` is: it returns `void`, so a caller *cannot* await it, and
 * it swallows its own failures into the log. A reader who just posted a
 * comment must never wait on -- or be shown an error from -- a badge.
 * `flushBadges` is the one seam that settles the writes, for the tests and for
 * a shutdown.
 *
 * **What the mock had and this does not.** The mock badge list carried four
 * badges with nothing behind them: minutes read in a week, reviews other
 * readers found helpful, reading after midnight, and posting in a club ten
 * weeks running. Scribe records no reading *duration*, has no helpfulness vote,
 * stores no local clock for a reader, and keeps no per-week history of club
 * posts. Each was dropped rather than faked -- the same call the clubs and
 * channels work made about `isPrivate` and `likeCount` -- and replaced by a
 * threshold on a metric that is really counted.
 */

import { or } from "@prisma/orm-postgres/orm-client";
import { db } from "../prisma/db.js";
import { HttpError } from "../lib/http-error.js";
import { logger } from "../lib/logger.js";
import { notify } from "./notifications.js";
import { toIso } from "./stories.js";

/* The catalogue ---------------------------------------------------------- */

/**
 * Everything a badge can be earned by.
 *
 * Every one is countable from rows that already exist, and every one is
 * computed in the single query in `metricsFor`. Adding a metric means adding a
 * sub-select there; adding a *badge* means adding a row to `BADGES` and
 * nothing else.
 */
export const BADGE_METRICS = [
  /** Distinct stories the reader has opened a chapter of. */
  "storiesRead",
  /** Distinct chapters the reader has opened. */
  "chaptersRead",
  /** Comments and replies the reader has posted on stories. */
  "commentsPosted",
  /** Stories the reader has scored. */
  "ratingsGiven",
  /** Threads and replies the reader has posted in book clubs. */
  "clubPosts",
  /** People following this account. */
  "followers",
  /**
   * The reader's *longest* run, not the one they are on.
   *
   * It was the current streak, which made "read 30 days in a row" earnable
   * only while the run was still alive -- somebody who managed forty days last
   * year and is on three today could not hold a badge they had plainly earned.
   * `auth.User.longestStreak` is the column that fixed it. Still not what
   * drives a level; see `levelsFor`.
   */
  "streakDays",
  /** Listed stories this author has written. */
  "storiesPublished",
  /** Published chapters across them. */
  "chaptersPublished",
  /** Words across every chapter, draft ones included. */
  "wordsWritten",
  /** `content.Story.viewCount` summed across the author's stories. */
  "storyViews",
] as const;

export type BadgeMetric = (typeof BADGE_METRICS)[number];

export type Metrics = Record<BadgeMetric, number>;

export type BadgeTier = "bronze" | "silver" | "gold";

export type BadgeCategory = "reading" | "writing" | "community";

export interface BadgeDefinition {
  /** Stable key stored in `gamification.UserBadge.code`. Never reused. */
  code: string;
  name: string;
  /** Shown once the badge is earned. */
  description: string;
  /** Shown while it is locked: what to do to get it. */
  criteria: string;
  /** Key into `BADGE_ICONS` in `components/story/Cards.tsx`. */
  icon: string;
  tier: BadgeTier;
  category: BadgeCategory;
  metric: BadgeMetric;
  /** Earned once the metric reaches this value. */
  threshold: number;
}

/**
 * The catalogue.
 *
 * Ordered the way the badges page reads best -- reading, then writing, then
 * community, each from cheapest to hardest -- because nothing else imposes an
 * order and a list sorted by nothing looks like a bug.
 */
export const BADGES: readonly BadgeDefinition[] = [
  {
    code: "chapters-10",
    name: "Ten Chapters",
    description: "Read ten chapters on Scribe.",
    criteria: "Read 10 chapters",
    icon: "library",
    tier: "bronze",
    category: "reading",
    metric: "chaptersRead",
    threshold: 10,
  },
  {
    code: "chapters-100",
    name: "100 Chapters",
    description: "Read one hundred chapters.",
    criteria: "Read 100 chapters",
    icon: "library",
    tier: "silver",
    category: "reading",
    metric: "chaptersRead",
    threshold: 100,
  },
  {
    code: "stories-25",
    name: "Well Read",
    description: "Opened twenty-five different stories.",
    criteria: "Read 25 different stories",
    icon: "book",
    tier: "silver",
    category: "reading",
    metric: "storiesRead",
    threshold: 25,
  },
  {
    code: "streak-7",
    name: "7 Day Streak",
    description: "Read something every day for a week.",
    criteria: "Read 7 days in a row",
    icon: "flame",
    tier: "silver",
    category: "reading",
    metric: "streakDays",
    threshold: 7,
  },
  {
    code: "streak-30",
    name: "30 Day Streak",
    description: "Read something every day for a month.",
    criteria: "Read 30 days in a row",
    icon: "flame",
    tier: "gold",
    category: "reading",
    metric: "streakDays",
    threshold: 30,
  },
  {
    code: "first-chapter",
    name: "First Chapter",
    description: "Published your first chapter.",
    criteria: "Publish one chapter",
    icon: "pencil",
    tier: "bronze",
    category: "writing",
    metric: "chaptersPublished",
    threshold: 1,
  },
  {
    code: "first-story",
    name: "First Story",
    description: "Published your first story on Scribe.",
    criteria: "Publish one story",
    icon: "book",
    tier: "bronze",
    category: "writing",
    metric: "storiesPublished",
    threshold: 1,
  },
  {
    code: "words-10k",
    name: "Ten Thousand Words",
    description: "Wrote ten thousand words of story.",
    criteria: "Write 10,000 words",
    icon: "pencil",
    tier: "silver",
    category: "writing",
    metric: "wordsWritten",
    threshold: 10_000,
  },
  {
    code: "rising-author",
    name: "Rising Author",
    description: "Reached 1,000 views across your stories.",
    criteria: "Earn 1,000 views",
    icon: "trend",
    tier: "silver",
    category: "writing",
    metric: "storyViews",
    threshold: 1_000,
  },
  {
    code: "words-50k",
    name: "Novel Length",
    description: "Wrote fifty thousand words of story.",
    criteria: "Write 50,000 words",
    icon: "trophy",
    tier: "gold",
    category: "writing",
    metric: "wordsWritten",
    threshold: 50_000,
  },
  {
    code: "popular-writer",
    name: "Popular Writer",
    description: "Reached 50,000 views across your stories.",
    criteria: "Earn 50,000 views",
    icon: "crown",
    tier: "gold",
    category: "writing",
    metric: "storyViews",
    threshold: 50_000,
  },
  {
    code: "first-review",
    name: "First Review",
    description: "Scored your first story.",
    criteria: "Rate one story",
    icon: "star",
    tier: "bronze",
    category: "community",
    metric: "ratingsGiven",
    threshold: 1,
  },
  {
    code: "first-comment",
    name: "First Comment",
    description: "Left your first comment on a story.",
    criteria: "Comment on one story",
    icon: "quote",
    tier: "bronze",
    category: "community",
    metric: "commentsPosted",
    threshold: 1,
  },
  {
    code: "critic-25",
    name: "Thoughtful Critic",
    description: "Left twenty-five comments on other people's work.",
    criteria: "Post 25 comments",
    icon: "quote",
    tier: "silver",
    category: "community",
    metric: "commentsPosted",
    threshold: 25,
  },
  {
    code: "club-regular",
    name: "Book Club Regular",
    description: "Posted ten times in club discussions.",
    criteria: "Post 10 times in a club",
    icon: "users",
    tier: "silver",
    category: "community",
    metric: "clubPosts",
    threshold: 10,
  },
  {
    code: "followed-10",
    name: "Worth Following",
    description: "Ten readers follow you.",
    criteria: "Reach 10 followers",
    icon: "users",
    tier: "silver",
    category: "community",
    metric: "followers",
    threshold: 10,
  },
  {
    code: "followed-100",
    name: "Widely Followed",
    description: "A hundred readers follow you.",
    criteria: "Reach 100 followers",
    icon: "crown",
    tier: "gold",
    category: "community",
    metric: "followers",
    threshold: 100,
  },
];

const BY_CODE = new Map(BADGES.map((badge) => [badge.code, badge]));

/* Levels ----------------------------------------------------------------- */

/**
 * The two level curves: the metric value at which each level begins.
 *
 * Level *n* is reached at `ladder[n - 1]`, so level 1 is where everybody
 * starts and the top of the ladder is the highest level there is. Each step is
 * a multiple of the last -- five times at the bottom, narrowing to two and a
 * half at the top -- which is what makes the early levels arrive quickly
 * enough to mean something and the last one take a while.
 *
 * One metric per curve rather than a weighted score of several. A score would
 * have to justify its weights, and nothing here can: "is a comment worth three
 * chapters?" has no answer, and the number picked would be the thing readers
 * actually optimised. Chapters read and words written are the two figures that
 * unambiguously say how much somebody has read and how much they have written.
 */
const READER_LADDER = [0, 10, 50, 150, 400, 1_000, 2_500] as const;

const AUTHOR_LADDER = [0, 1_000, 5_000, 20_000, 50_000, 120_000, 300_000] as const;

export interface LevelProgress {
  level: number;
  /** The metric the level was derived from, so the UI can show the figure. */
  value: number;
  /** Where the next level begins, or null at the top of the ladder. */
  next: number | null;
  /** 0-1 from the current level's floor to `next`; 1 at the top. */
  progress: number;
}

function levelOn(ladder: readonly number[], value: number): LevelProgress {
  let level = 1;
  for (let index = 0; index < ladder.length; index += 1) {
    if (value >= (ladder[index] as number)) level = index + 1;
  }

  const floor = ladder[level - 1] ?? 0;
  const next = ladder[level] ?? null;

  return {
    level,
    value,
    next,
    progress:
      next === null || next === floor
        ? 1
        : Math.min(1, Math.max(0, (value - floor) / (next - floor))),
  };
}

export interface Levels {
  reader: LevelProgress;
  author: LevelProgress;
}

/**
 * Both levels for a set of metrics.
 *
 * Deliberately *not* driven by `streakDays`. That metric is monotonic now that
 * it reads the longest run rather than the current one, so it would no longer
 * fall back -- but a level is a measure of how much somebody has read, and a
 * streak measures when. A streak earns badges, which are a record of having
 * done it once; a level is cumulative and only ever goes up.
 */
export function levelsFor(metrics: Metrics): Levels {
  return {
    reader: levelOn(READER_LADDER, metrics.chaptersRead),
    author: levelOn(AUTHOR_LADDER, metrics.wordsWritten),
  };
}

/* Metrics ---------------------------------------------------------------- */

/**
 * Every metric for one account, in one round trip.
 *
 * Independent sub-selects rather than joins: the eleven figures come from
 * seven tables at six different grains, and joining them would multiply rows
 * against each other -- the same reason `services/analytics.ts` reaches for a
 * lateral per story instead of one grouped join across both event tables. Each
 * sub-select reads an indexed column and returns one number.
 *
 * `source = 'SCRIBE'` on every author figure, the same filter
 * `countVisibleStoriesBy` applies: a seeded catalogue edition carries a real
 * author column and nobody on Scribe wrote it, so counting it would hand
 * somebody a writing badge for an import.
 *
 * `hiddenAt IS NULL` on the two figures counting somebody's own posts, for the
 * neighbouring reason: credit for something a moderator took down is credit
 * for nothing. A badge already awarded is kept -- `UserBadge` is a record of
 * the award, not of the metric -- so this changes what is earnable from here,
 * not what was earned. See `services/moderation.ts`.
 */
export async function metricsFor(userId: string): Promise<Metrics> {
  const plan = db.raw.sql`
    SELECT
      (SELECT COUNT(DISTINCT r."storyId")
         FROM "engagement"."chapterRead" AS r
        WHERE r."userId" = ${userId})::int                       AS "storiesRead",
      (SELECT COUNT(DISTINCT r."chapterId")
         FROM "engagement"."chapterRead" AS r
        WHERE r."userId" = ${userId})::int                       AS "chaptersRead",
      (SELECT COUNT(*)
         FROM "engagement"."comment" AS c
        WHERE c."userId" = ${userId}
          AND c."hiddenAt" IS NULL)::int                         AS "commentsPosted",
      (SELECT COUNT(*)
         FROM "engagement"."rating" AS t
        WHERE t."userId" = ${userId})::int                       AS "ratingsGiven",
      (SELECT COUNT(*)
         FROM "clubs"."clubDiscussion" AS d
        WHERE d."userId" = ${userId}
          AND d."hiddenAt" IS NULL)::int                         AS "clubPosts",
      (SELECT COUNT(*)
         FROM "engagement"."follow" AS f
        WHERE f."followingId" = ${userId})::int                  AS "followers",
      -- The longest run the reader has ever had, not the one they are on.
      -- GREATEST rather than the stored column alone because longestStreak
      -- starts at 0 for every account that predates it and only catches up on
      -- the next read: the current streak is a lower bound on the longest that
      -- is always true and costs nothing to include. See the migration.
      (SELECT COALESCE(MAX(GREATEST(u."longestStreak", u."readingStreak")), 0)
         FROM "auth"."user" AS u
        WHERE u."id" = ${userId})::int                           AS "streakDays",
      (SELECT COUNT(*)
         FROM "content"."story" AS s
        WHERE s."authorId" = ${userId}
          AND s."source" = 'SCRIBE'
          AND s."listedAt" IS NOT NULL)::int                     AS "storiesPublished",
      (SELECT COUNT(*)
         FROM "content"."chapter" AS ch
         JOIN "content"."story" AS s ON s."id" = ch."storyId"
        WHERE s."authorId" = ${userId}
          AND s."source" = 'SCRIBE'
          AND ch."publishedAt" IS NOT NULL)::int                 AS "chaptersPublished",
      (SELECT COALESCE(SUM(ch."wordCount"), 0)
         FROM "content"."chapter" AS ch
         JOIN "content"."story" AS s ON s."id" = ch."storyId"
        WHERE s."authorId" = ${userId}
          AND s."source" = 'SCRIBE')::int                        AS "wordsWritten",
      (SELECT COALESCE(SUM(s."viewCount"), 0)
         FROM "content"."story" AS s
        WHERE s."authorId" = ${userId}
          AND s."source" = 'SCRIBE')::int                        AS "storyViews"
  `.returnsRow({
    storiesRead: "pg/int4@1",
    chaptersRead: "pg/int4@1",
    commentsPosted: "pg/int4@1",
    ratingsGiven: "pg/int4@1",
    clubPosts: "pg/int4@1",
    followers: "pg/int4@1",
    streakDays: "pg/int4@1",
    storiesPublished: "pg/int4@1",
    chaptersPublished: "pg/int4@1",
    wordsWritten: "pg/int4@1",
    storyViews: "pg/int4@1",
  }).build();

  const [row] = (await db.runtime().query(plan)) as Metrics[];

  // A user id that names nobody yields a row of zeroes rather than no row --
  // every sub-select is an aggregate -- so this only guards a changed query.
  return row ?? emptyMetrics();
}

function emptyMetrics(): Metrics {
  return Object.fromEntries(
    BADGE_METRICS.map((metric) => [metric, 0]),
  ) as Metrics;
}

/* Awarding --------------------------------------------------------------- */

/** One badge, with what the caller has done toward it. */
export interface BadgeProgress {
  badge: Omit<BadgeDefinition, "metric" | "threshold">;
  earned: boolean;
  earnedAt: string | null;
  /** 0-1 toward the threshold; 1 once earned. */
  progress: number;
}

function summarise(definition: BadgeDefinition): BadgeProgress["badge"] {
  const { metric: _metric, threshold: _threshold, ...badge } = definition;
  return badge;
}

/**
 * In-flight award writes.
 *
 * The same seam `services/analytics.ts` keeps, and for the same two callers: a
 * test that asserts an event awarded something, and a shutdown that should not
 * drop a write already issued.
 */
const pending = new Set<Promise<unknown>>();

/** Settles every award write issued so far. */
export async function flushBadges(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}

/**
 * Re-evaluates one account's badges and levels after something they did.
 *
 * `void`, so no handler can accidentally make a reader wait for it, and no
 * failure here can fail the write it followed. Call it from the service that
 * performed the write rather than from the route, so a second caller of the
 * same service cannot forget to.
 *
 * Which event moved which metric does not matter: this recomputes all of them.
 * That is what makes a *missed* call harmless -- the next event of any kind
 * catches up, and `GET /api/badges` evaluates before it answers, so the badges
 * page is never showing a stale award.
 */
export function evaluateBadges(userId: string | null | undefined): void {
  if (!userId) return;

  const work = awardBadges(userId).catch((error: unknown) => {
    // A badge is never worth a failed request. Warn rather than error so a
    // broken engine is visible without being paged on -- the same level
    // `services/analytics.ts` logs a dropped event at.
    logger.warn({ err: error, userId }, "gamification: evaluation failed");
  });

  pending.add(work);
  void work.finally(() => pending.delete(work));
}

/** One evaluation's findings, so the read path need not recompute them. */
interface Evaluation {
  metrics: Metrics;
  /** Every badge the account holds afterwards, and when it earned each. */
  earnedAt: Map<string, string>;
  /** The subset this call inserted. */
  newlyEarned: BadgeProgress["badge"][];
}

/**
 * The awaitable half of `evaluateBadges`, for the read path.
 *
 * Returns what was *newly* earned by this call -- an empty array whenever the
 * account already had everything it qualifies for, which is the common case.
 */
export async function awardBadges(
  userId: string,
): Promise<BadgeProgress["badge"][]> {
  return (await evaluate(userId)).newlyEarned;
}

async function evaluate(userId: string): Promise<Evaluation> {
  const [metrics, earnedAt] = await Promise.all([
    metricsFor(userId),
    earnedAtFor(userId),
  ]);

  /**
   * Held badges are read first so the steady state writes nothing at all --
   * this runs after every debounced scroll save, and a reader with ten badges
   * would otherwise issue ten inserts a second for them to all conflict.
   *
   * The read is not the idempotency, though: two evaluations racing after two
   * events both see "not earned" and both insert, and the unique key is what
   * makes exactly one of them land. This only keeps the common case quiet.
   */
  const missing = BADGES.filter(
    (badge) =>
      metrics[badge.metric] >= badge.threshold && !earnedAt.has(badge.code),
  );

  const newlyEarned: BadgeProgress["badge"][] = [];
  for (const badge of missing) {
    const at = await insertBadge(userId, badge.code);
    if (at === null) continue;

    earnedAt.set(badge.code, at);
    newlyEarned.push(summarise(badge));

    /**
     * Told to the reader wherever they are, which is the point: a badge is
     * awarded by whichever event moved its metric, and they are almost never
     * looking at the badges page when that happens.
     *
     * Inside the loop and keyed on `at !== null`, so exactly one notification
     * exists per award -- `insertBadge` returns a row only for the insert that
     * really landed, so two evaluations racing on the same badge produce one
     * call here rather than two. The name and description travel with the
     * event because the catalogue is this file's array and not a table; see
     * `NotificationEvent` for why that is the one event carrying text.
     */
    notify({
      event: "badge-earned",
      userId,
      name: badge.name,
      description: badge.description,
    });
  }

  const levels = levelsFor(metrics);
  await writeLevels(userId, levels);
  await announceLevels(userId, levels);

  return { metrics, earnedAt, newlyEarned };
}

/**
 * Records one award, and answers when it landed -- or null if the account
 * already had it.
 *
 * `RETURNING` rather than a row count: `ON CONFLICT DO NOTHING` returns no row
 * for a conflict and exactly one for an insert, which is the same answer
 * without depending on how the driver reports statement statistics.
 */
async function insertBadge(
  userId: string,
  code: string,
): Promise<string | null> {
  const plan = db.raw.sql`
    INSERT INTO "gamification"."userBadge" ("id", "userId", "code", "earnedAt")
    VALUES (gen_random_uuid()::text, ${userId}, ${code}, now())
    ON CONFLICT ("userId", "code") DO NOTHING
    RETURNING "earnedAt"
  `.returnsRow({ earnedAt: "pg/timestamptz-temporal@1" }).build();

  const [row] = (await db.runtime().query(plan)) as { earnedAt: unknown }[];

  return row ? toIso(row.earnedAt) : null;
}

/** What each ladder is called where a reader sees it. */
const LADDER_NAMES = { reader: "Reader", author: "Author" } as const;

/**
 * Stores the derived levels, and only when one of them moved.
 *
 * The `WHERE` is the guard, not a read followed by a decision: two evaluations
 * racing after two events both write the same numbers -- they derived them
 * from the same ladder -- so there is nothing to lose and no reason to pay for
 * a round trip to find that out.
 *
 * The guard is not an optimisation. `auth.User.updatedAt` is a column the
 * account page shows, and an unconditional write would move it every time
 * anybody read a chapter.
 */
async function writeLevels(userId: string, levels: Levels): Promise<void> {
  await db.orm.auth.User.where((user) => user.id.eq(userId))
    .where((user) =>
      or(
        user.readerLevel.neq(levels.reader.level),
        user.authorLevel.neq(levels.author.level),
      ),
    )
    .update({
      readerLevel: levels.reader.level,
      authorLevel: levels.author.level,
    });
}

/**
 * Tells the reader about a level they have crossed, once.
 *
 * **Why this needs two more columns rather than reusing `readerLevel`.** A
 * badge is *awarded*: `insertBadge` returns a row exactly when the award is
 * new, so "it just happened" is something the database can answer. A level is
 * *derived* on every evaluation -- it is a function of a metric and a ladder --
 * so nothing anywhere knew the difference between a level that had just
 * changed and one that had merely been high for months. `announcedReaderLevel`
 * and `announcedAuthorLevel` are that missing knowledge: the gap between
 * derived and announced is the announcement owed.
 *
 * The write is the guard, as in `writeLevels` above, and it returns the values
 * it *replaced*. That is the whole trick: after the update both ladders read
 * equal to their derived level whether or not they moved, so the post-update
 * row cannot say which announcement was owed. `prev` captures the row before
 * the write -- under `FOR UPDATE`, so a second evaluation racing this one
 * blocks rather than reading the same "before" -- and a ladder is announced
 * exactly when the value it replaced was lower.
 *
 * Only ever upward. A level cannot fall today, but if a metric were ever
 * recounted downward the reader should not be told they have *lost* a level by
 * a notification designed to congratulate them, and the announced column
 * should not follow it down and re-announce the recovery.
 */
async function announceLevels(userId: string, levels: Levels): Promise<void> {
  const plan = db.raw.sql`
    UPDATE "auth"."user" AS u
       SET "announcedReaderLevel" = GREATEST(u."announcedReaderLevel", ${levels.reader.level}),
           "announcedAuthorLevel" = GREATEST(u."announcedAuthorLevel", ${levels.author.level})
      FROM (SELECT "id",
                   "announcedReaderLevel" AS "wasReader",
                   "announcedAuthorLevel" AS "wasAuthor"
              FROM "auth"."user"
             WHERE "id" = ${userId}
               FOR UPDATE) AS prev
     WHERE u."id" = prev."id"
       AND (prev."wasReader" < ${levels.reader.level}
         OR prev."wasAuthor" < ${levels.author.level})
    RETURNING prev."wasReader", prev."wasAuthor"
  `.returnsRow({
    wasReader: "pg/int4@1",
    wasAuthor: "pg/int4@1",
  }).build();

  const rows = (await db.runtime().query(plan)) as {
    wasReader: number;
    wasAuthor: number;
  }[];

  // No row means somebody else got there first, or nothing moved.
  const previous = rows[0];
  if (!previous) return;

  for (const ladder of ["reader", "author"] as const) {
    const progress = levels[ladder];
    const was = ladder === "reader" ? previous.wasReader : previous.wasAuthor;

    // This ladder is only the reason for the row if it is the one that moved.
    if (was >= progress.level) continue;

    notify({
      event: "level-up",
      userId,
      title: `${LADDER_NAMES[ladder]} level ${progress.level}`,
      description:
        ladder === "reader"
          ? `You have read ${progress.value.toLocaleString("en")} chapters.`
          : `You have written ${progress.value.toLocaleString("en")} words.`,
    });
  }
}

/* Reading ---------------------------------------------------------------- */

export interface BadgeCollection {
  badges: BadgeProgress[];
  levels: Levels;
  /**
   * Awarded by *this* request's evaluation. Non-empty only when an event
   * moved a metric and nothing has re-evaluated since, so the client cannot
   * rely on it alone to know what is new -- see `useEarnedBadges` on the web
   * side, which diffs against what it last showed.
   */
  newlyEarned: BadgeProgress["badge"][];
}

/**
 * The caller's own collection.
 *
 * Evaluates before it reads, and awaits it. Everywhere else an evaluation is
 * fire-and-forget because a reader is waiting on something else; here the
 * badges *are* what they are waiting for, and a page that showed 99% on a
 * badge the database was about to award would be the one place the lag is
 * visible.
 */
export async function getMyBadges(userId: string): Promise<BadgeCollection> {
  const { metrics, earnedAt, newlyEarned } = await evaluate(userId);

  return {
    badges: BADGES.map((badge) => {
      const at = earnedAt.get(badge.code) ?? null;

      return {
        badge: summarise(badge),
        earned: at !== null,
        earnedAt: at,
        progress:
          at !== null
            ? 1
            : Math.min(1, Math.max(0, metrics[badge.metric] / badge.threshold)),
      };
    }),
    levels: levelsFor(metrics),
    newlyEarned,
  };
}

/**
 * Somebody else's collection: what they have earned, and nothing else.
 *
 * Deliberately not the full catalogue with their progress on it. A stranger's
 * position on "post 25 comments" is a readout of how much they use the site,
 * which is theirs and not the caller's -- and the profile page only ever draws
 * the earned ones. No levels either: `getPublicProfile` already carries
 * `readerLevel` and `authorLevel`, and a second answer to the same question is
 * the thing a second endpoint should not become.
 *
 * No evaluation, unlike `getMyBadges`. Recomputing eleven aggregates for
 * whoever happens to be looking would let a stranger's page load do the
 * subject's write, and the subject's own next action does it anyway.
 */
export async function getUserBadges(
  username: string,
): Promise<{ badges: BadgeProgress[] }> {
  const user = await db.orm.auth.User.select("id")
    .where((row) => row.username.eq(username.trim().toLowerCase()))
    .first();

  if (!user) throw HttpError.notFound("That profile could not be found.");

  const earnedAt = await earnedAtFor(user.id);

  return {
    badges: BADGES.filter((badge) => earnedAt.has(badge.code)).map((badge) => ({
      badge: summarise(badge),
      earned: true,
      earnedAt: earnedAt.get(badge.code) ?? null,
      progress: 1,
    })),
  };
}

/**
 * When each badge this account holds was earned.
 *
 * A row whose `code` is no longer in the catalogue is skipped rather than
 * deleted -- a retired badge stays in somebody's history in case it comes
 * back, and the read paths above iterate the catalogue, so it simply never
 * appears.
 */
async function earnedAtFor(userId: string): Promise<Map<string, string>> {
  const rows = await db.orm.gamification.UserBadge.select("code", "earnedAt")
    .where((row) => row.userId.eq(userId))
    .all();

  const earned = new Map<string, string>();
  for (const row of rows) {
    if (!BY_CODE.has(row.code)) continue;

    const at = toIso(row.earnedAt);
    if (at !== null) earned.set(row.code, at);
  }

  return earned;
}
