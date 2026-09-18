/**
 * What to read next.
 *
 * One ranked list, built from four signals the reader has already produced --
 * the genres they named in onboarding (`auth.GenrePreference`), the books on
 * their shelves (`library.LibraryEntry`), where they have been reading
 * (`engagement.ReadingHistory`) and what they scored (`engagement.Rating`) --
 * plus who they follow. Everything below is decided by this file and nothing
 * else decides any of it.
 *
 * **The score is one function, in one statement.** `rankStories` below is the
 * whole of it: seven weighted terms summed in SQL, ordered there, and paged
 * there. Ranking in the database rather than in this process is not an
 * optimisation for its own sake -- a JS ranker would have to load every listed
 * story to sort them, which is the query that stops working first. The cost is
 * that the weights live in SQL text; `WEIGHTS` below is where they are named
 * and the only place they are written down.
 *
 * **The score is deterministic.** No clock beyond a 30-day freshness window,
 * no randomness, no per-request shuffle. Two identical requests a second apart
 * return the same order, which is what makes the ranking testable at all and
 * what stops a reader's shelf jumping under them when a rail re-fetches. `id`
 * is the final tie-break, so equal scores cannot swap places between pages.
 *
 * **A reader with no signal gets trending, not an empty list.** `hasSignal`
 * asks whether any of the five sources has a row; when none does, every
 * personal term is zero and the ranking degenerates to "quality plus
 * popularity", which is *nearly* trending and differs from it for no reason a
 * reader could see. So the cold-start path delegates to `listStories({ sort:
 * "trending" })` instead -- there is one definition of trending in this
 * codebase and this is not a second one. The response says which path ran, in
 * `basis`, so a client can word the shelf honestly.
 *
 * **Only stories are recommended, never catalogue editions.** The same rule
 * `getRelatedStories` states: a rail like this is a recommendation to a
 * reader, and Scribe's own serialised writing is what it exists to surface.
 * Catalogue editions still *feed* it -- a shelf full of imported fantasy is
 * what teaches the ranker that this reader likes fantasy -- they are simply
 * not what comes back. The books rails on the home page are unchanged.
 *
 * **Nothing already met comes back.** A story on any shelf, at any reading
 * position, or carrying a rating from this reader is excluded outright, along
 * with the reader's own work. Shelving something is a decision already taken;
 * repeating it back as a suggestion is the recommender's most annoying
 * failure mode and the cheapest to prevent.
 */

import { db } from "../prisma/db.js";
import {
  getStoriesByIds,
  listStories,
  type Story,
  type StoryGenre,
} from "./stories.js";
import { CONTENT_LENGTHS, type ContentLength } from "./preferences.js";

/**
 * What each term contributes at full strength.
 *
 * Read as a budget: an explicitly chosen genre is worth more than every other
 * term put together, because it is the one signal the reader gave on purpose.
 * Everything below it is inferred from behaviour and weighted accordingly, and
 * the two impersonal terms -- quality and popularity -- are deliberately small,
 * enough to break ties between equally-relevant stories and not enough to put
 * a popular story the reader has no interest in above a relevant one.
 *
 * | Term         | Full | What earns it                                    |
 * |--------------|------|--------------------------------------------------|
 * | `genre`      |  4.0 | per preferred genre the story carries, up to two |
 * | `history`    |  2.5 | genres of what they shelved, read and rated well |
 * | `follow`     |  3.0 | written by somebody they follow                  |
 * | `length`     |  1.5 | matches their preferred length                   |
 * | `quality`    |  1.5 | scaled from the story's average rating           |
 * | `popularity` |  0.2 | times the log of views plus twice likes          |
 * | `fresh`      |  1.0 | listed within `FRESH_DAYS`                       |
 *
 * Changing a number here changes the ranking and nothing else; every one of
 * them is bound into the statement as a parameter rather than written into it.
 */
const WEIGHTS = {
  genre: 4.0,
  history: 2.5,
  follow: 3.0,
  length: 1.5,
  quality: 1.5,
  popularity: 0.2,
  fresh: 1.0,
} as const;

/**
 * How many preferred genres one story can be paid for.
 *
 * A story tagged with six genres, three of which the reader named, is not
 * three times as relevant as one tagged with the one genre they actually care
 * about -- it is a story with a lot of tags. Two is where the curve flattens.
 */
const MAX_GENRE_HITS = 2;

/** A story listed within this many days counts as new. */
const FRESH_DAYS = 30;

/**
 * Where one length ends and the next begins, in words of published chapters.
 *
 * The only place `ContentLength` is turned into a number, which is what the
 * enum's contract comment promises. The boundaries are a reader's afternoon
 * and a reader's fortnight rather than anything the data suggested: under
 * 7,500 words is an hour at a comfortable pace, and past 40,000 a story is a
 * novel by every definition that counts them.
 *
 * A story with no published chapters has zero words and is therefore `SHORT`.
 * That is honest -- there is nothing there to read yet -- and it matters only
 * to a reader who asked for short things, who will find it near the top and
 * bounce off an empty story. Listing a story with nothing in it is the problem
 * there, not this boundary.
 */
const LENGTH_BUCKETS = { shortMax: 7_500, longMin: 40_000 } as const;

/* Shapes returned to the client ------------------------------------------ */

/** Which of the two paths produced the list. */
export type RecommendationBasis = "personal" | "trending";

export interface Recommendation {
  story: Story;
  /** The summed score, rounded to two places. Present so a client can show
   * its working and a test can assert an ordering rather than a list. */
  score: number;
  /** The strongest term, worded for a reader. Never empty. */
  reason: string;
}

export interface Recommendations {
  items: Recommendation[];
  basis: RecommendationBasis;
}

/** A writer worth following, for the onboarding step that asks. */
export interface AuthorSuggestion {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  followerCount: number;
  /** Listed stories, so the card can say why this person is on the list. */
  storyCount: number;
}

export const MAX_RECOMMENDATIONS = 24;
export const MAX_AUTHOR_SUGGESTIONS = 24;

/* Scalar normalisation --------------------------------------------------- */

/** `numeric` decodes to a decimal string, because a float would lie about it. */
function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/* Signal ----------------------------------------------------------------- */

interface SignalRow {
  genres: number;
  shelved: number;
  reading: number;
  rated: number;
  follows: number;
}

/**
 * Whether this reader has given the ranker anything to work with.
 *
 * Five counts in one round trip rather than five queries, and counts rather
 * than existence checks because the same statement answers "is there any
 * signal?" for the caller and reads as an explanation of what signal means.
 */
async function hasSignal(userId: string): Promise<boolean> {
  const plan = db.raw.sql`
    SELECT
      (SELECT COUNT(*) FROM "auth"."genrePreference" AS g
        WHERE g."userId" = ${userId})::int             AS "genres",
      (SELECT COUNT(*) FROM "library"."libraryEntry" AS l
        WHERE l."userId" = ${userId})::int             AS "shelved",
      (SELECT COUNT(*) FROM "engagement"."readingHistory" AS h
        WHERE h."userId" = ${userId})::int             AS "reading",
      (SELECT COUNT(*) FROM "engagement"."rating" AS r
        WHERE r."userId" = ${userId})::int             AS "rated",
      (SELECT COUNT(*) FROM "engagement"."follow" AS f
        WHERE f."followerId" = ${userId})::int         AS "follows"
  `.returnsRow({
    genres: "pg/int4@1",
    shelved: "pg/int4@1",
    reading: "pg/int4@1",
    rated: "pg/int4@1",
    follows: "pg/int4@1",
  }).build();

  const [row] = (await db.runtime().query(plan)) as SignalRow[];
  if (!row) return false;

  return (
    row.genres + row.shelved + row.reading + row.rated + row.follows > 0
  );
}

/* Ranking ---------------------------------------------------------------- */

interface RankedRow {
  id: string;
  genreScore: unknown;
  historyScore: unknown;
  followScore: unknown;
  lengthScore: unknown;
  qualityScore: unknown;
  popularityScore: unknown;
  freshScore: unknown;
  score: unknown;
}

/**
 * The scoring function.
 *
 * Reading order, top to bottom:
 *
 * - `preferred` — the genres the reader named. The explicit signal.
 * - `signal` — every story the reader has touched, carrying the weight that
 *   touching it implies. A rating of 4 or 5 is worth twice a shelf slot; a
 *   rating of 1 or 2 is worth *less than nothing*, so a genre somebody
 *   actively disliked pulls its stories down rather than merely not helping.
 *   A 3 is worth zero, which is what a shrug should be.
 * - `taste` — those weights collapsed onto genres. The inferred signal.
 * - `scale` — the largest genre weight, so `taste` can be normalised into
 *   [-1, 1] and a reader with four hundred shelved books does not score
 *   differently from one with four. Floored at 1 so it can never divide by
 *   zero or amplify a single row into certainty.
 * - `candidate` — listed Scribe stories the reader has not met and did not
 *   write. `NOT EXISTS` against `signal` rather than a `NOT IN`, so a null
 *   cannot swallow the whole set.
 * - `measured` — each candidate's raw inputs, including its word count from a
 *   lateral over published chapters. One lateral per candidate row, which is
 *   the shape `services/analytics.ts` uses and for the same reason: the
 *   alternative multiplies rows against the genre join.
 * - `weighted` — the seven terms. A separate step only because SQL cannot
 *   reference a select-list alias from the same select list.
 *
 * The whole thing is one statement, so the database sees one plan and this
 * process never holds more than `limit` rows.
 */
async function rankStories(
  userId: string,
  contentLength: ContentLength,
  limit: number,
): Promise<RankedRow[]> {
  const plan = db.raw.sql`
    WITH "preferred" AS (
      SELECT "genreId" FROM "auth"."genrePreference" WHERE "userId" = ${userId}
    ),
    "signal" AS (
      SELECT "storyId", 1.0::numeric AS "weight"
        FROM "library"."libraryEntry" WHERE "userId" = ${userId}
      UNION ALL
      SELECT "storyId", 1.0::numeric
        FROM "engagement"."readingHistory" WHERE "userId" = ${userId}
      UNION ALL
      SELECT "storyId",
             CASE WHEN "rating" >= 4 THEN 2.0::numeric
                  WHEN "rating" <= 2 THEN -1.5::numeric
                  ELSE 0.0::numeric END
        FROM "engagement"."rating" WHERE "userId" = ${userId}
    ),
    "taste" AS (
      SELECT sg."genreId", SUM(sig."weight") AS "weight"
        FROM "signal" AS sig
        JOIN "content"."storyGenre" AS sg ON sg."storyId" = sig."storyId"
       GROUP BY sg."genreId"
    ),
    "scale" AS (
      SELECT GREATEST(COALESCE(MAX(ABS("weight")), 1.0), 1.0) AS "max" FROM "taste"
    ),
    "candidate" AS (
      SELECT s."id", s."authorId", s."ratingAverage", s."viewCount",
             s."likeCount", s."listedAt"
        FROM "content"."story" AS s
       WHERE s."source" = 'SCRIBE'
         AND s."listedAt" IS NOT NULL
         AND s."authorId" <> ${userId}
         AND NOT EXISTS (
               SELECT 1 FROM "signal" AS sig WHERE sig."storyId" = s."id"
             )
    ),
    "measured" AS (
      SELECT c."id",
             LEAST(
               (SELECT COUNT(*)
                  FROM "content"."storyGenre" AS sg
                  JOIN "preferred" AS p ON p."genreId" = sg."genreId"
                 WHERE sg."storyId" = c."id"),
               ${MAX_GENRE_HITS}
             )::int AS "hits",
             COALESCE(
               (SELECT SUM(t."weight")
                  FROM "content"."storyGenre" AS sg
                  JOIN "taste" AS t ON t."genreId" = sg."genreId"
                 WHERE sg."storyId" = c."id"),
               0
             ) AS "taste",
             EXISTS (
               SELECT 1 FROM "engagement"."follow" AS f
                WHERE f."followerId" = ${userId}
                  AND f."followingId" = c."authorId"
             ) AS "followed",
             COALESCE(c."ratingAverage", 3.0) AS "rating",
             c."viewCount", c."likeCount", c."listedAt",
             COALESCE(w."words", 0) AS "words"
        FROM "candidate" AS c
        LEFT JOIN LATERAL (
              SELECT SUM(ch."wordCount")::int AS "words"
                FROM "content"."chapter" AS ch
               WHERE ch."storyId" = c."id"
                 AND ch."publishedAt" IS NOT NULL
             ) AS w ON TRUE
    ),
    "weighted" AS (
      SELECT m."id",
             (m."hits" * ${WEIGHTS.genre}::numeric) AS "genreScore",
             (LEAST(GREATEST(m."taste" / (SELECT "max" FROM "scale"), -1.0), 1.0)
               * ${WEIGHTS.history}::numeric) AS "historyScore",
             (CASE WHEN m."followed" THEN ${WEIGHTS.follow}::numeric
                   ELSE 0::numeric END) AS "followScore",
             (CASE
                WHEN ${contentLength}::text = 'SHORT'
                     AND m."words" < ${LENGTH_BUCKETS.shortMax}
                  THEN ${WEIGHTS.length}::numeric
                WHEN ${contentLength}::text = 'MEDIUM'
                     AND m."words" >= ${LENGTH_BUCKETS.shortMax}
                     AND m."words" < ${LENGTH_BUCKETS.longMin}
                  THEN ${WEIGHTS.length}::numeric
                WHEN ${contentLength}::text = 'LONG'
                     AND m."words" >= ${LENGTH_BUCKETS.longMin}
                  THEN ${WEIGHTS.length}::numeric
                ELSE 0::numeric
              END) AS "lengthScore",
             ((m."rating" / 5.0) * ${WEIGHTS.quality}::numeric) AS "qualityScore",
             (ln(1 + m."viewCount" + 2 * m."likeCount")::numeric
               * ${WEIGHTS.popularity}::numeric) AS "popularityScore",
             (CASE
                WHEN m."listedAt" > now() - make_interval(days => ${FRESH_DAYS})
                  THEN ${WEIGHTS.fresh}::numeric
                ELSE 0::numeric
              END) AS "freshScore"
        FROM "measured" AS m
    )
    SELECT "id", "genreScore", "historyScore", "followScore", "lengthScore",
           "qualityScore", "popularityScore", "freshScore",
           ("genreScore" + "historyScore" + "followScore" + "lengthScore"
             + "qualityScore" + "popularityScore" + "freshScore") AS "score"
      FROM "weighted"
     ORDER BY "score" DESC, "id" DESC
     LIMIT ${limit}
  `.returnsRow({
    id: "pg/text@1",
    genreScore: "pg/numeric@1",
    historyScore: "pg/numeric@1",
    followScore: "pg/numeric@1",
    lengthScore: "pg/numeric@1",
    qualityScore: "pg/numeric@1",
    popularityScore: "pg/numeric@1",
    freshScore: "pg/numeric@1",
    score: "pg/numeric@1",
  }).build();

  return (await db.runtime().query(plan)) as RankedRow[];
}

/* Wording ---------------------------------------------------------------- */

/**
 * Turns the winning term into something a reader would say.
 *
 * Derived from the score components rather than recomputed, so the sentence
 * under a card cannot disagree with the reason it is there. Ties go to the
 * earlier entry, which puts the explicit signals ahead of the impersonal ones
 * -- "because you like Fantasy" is a better thing to read than "popular right
 * now" even when the two contributed the same amount.
 */
function reasonFor(
  row: RankedRow,
  story: Story,
  preferredGenreIds: Set<string>,
  contentLength: ContentLength,
): string {
  const matched: StoryGenre | undefined = story.genres.find((genre) =>
    preferredGenreIds.has(genre.id),
  );

  const authorName = story.author.displayName ?? story.author.username;

  const candidates: Array<{ score: number; text: string }> = [
    {
      score: toNumber(row.genreScore),
      text: matched ? `Because you like ${matched.name}` : "Picked for you",
    },
    { score: toNumber(row.followScore), text: `New from ${authorName}` },
    {
      score: toNumber(row.historyScore),
      text: "Like the stories on your shelves",
    },
    { score: toNumber(row.lengthScore), text: LENGTH_REASONS[contentLength] },
    { score: toNumber(row.qualityScore), text: "Readers rate this highly" },
    { score: toNumber(row.freshScore), text: "New on Scribe" },
    { score: toNumber(row.popularityScore), text: "Popular on Scribe" },
  ];

  let best = candidates[0]!;
  for (const candidate of candidates) {
    if (candidate.score > best.score) best = candidate;
  }

  return best.score > 0 ? best.text : "Picked for you";
}

const LENGTH_REASONS: Record<ContentLength, string> = {
  SHORT: "A short read, the way you like them",
  MEDIUM: "About the length you go for",
  LONG: "Long enough to get lost in",
  ANY: "Picked for you",
};

/* Queries ---------------------------------------------------------------- */

/**
 * The caller's preferred length and genres, read together.
 *
 * Read here rather than through `getPreferences` because the ranker needs
 * exactly these two fields and that function also reads the mutes and sorts
 * the genres into catalogue order, neither of which this cares about.
 */
async function rankingInputs(
  userId: string,
): Promise<{ contentLength: ContentLength; preferredGenreIds: Set<string> }> {
  const [row, genres] = await Promise.all([
    db.orm.auth.UserPreference.select("contentLength")
      .where((preference) => preference.userId.eq(userId))
      .first(),
    db.orm.auth.GenrePreference.select("genreId")
      .where((preference) => preference.userId.eq(userId))
      .all(),
  ]);

  const stored = row?.contentLength;
  const contentLength: ContentLength =
    stored !== undefined && (CONTENT_LENGTHS as readonly string[]).includes(stored)
      ? (stored as ContentLength)
      : "ANY";

  return {
    contentLength,
    preferredGenreIds: new Set(genres.map((genre) => genre.genreId)),
  };
}

/**
 * The ranked list, or trending when there is nothing to rank on.
 *
 * Stories are hydrated by `getStoriesByIds` as the caller, which is the same
 * function every other rail uses -- so a recommendation carries exactly the
 * fields a story card renders and there is no second story shape to keep in
 * step. A candidate that vanished between the ranking and the hydration is
 * simply absent from the map and drops out here, which thins the rail rather
 * than failing the request.
 */
export async function listRecommendations(
  userId: string,
  limit: number,
): Promise<Recommendations> {
  if (!(await hasSignal(userId))) {
    const trending = await listStories(
      { sort: "trending", page: 1, limit },
      // Anonymously, so the fallback cannot put the caller's own drafts on a
      // rail that is supposed to be somebody else's work. `listStories` shows
      // a caller their drafts by design; here that would be a bug.
      null,
    );

    return {
      basis: "trending",
      items: trending.items.map((story) => ({
        story,
        score: 0,
        reason: "Trending on Scribe",
      })),
    };
  }

  const { contentLength, preferredGenreIds } = await rankingInputs(userId);
  const ranked = await rankStories(userId, contentLength, limit);

  const stories = await getStoriesByIds(
    ranked.map((row) => row.id),
    userId,
  );

  const items: Recommendation[] = [];
  for (const row of ranked) {
    const story = stories.get(row.id);
    if (!story) continue;

    items.push({
      story,
      score: round(toNumber(row.score)),
      reason: reasonFor(row, story, preferredGenreIds, contentLength),
    });
  }

  return { basis: "personal", items };
}

/* Authors ---------------------------------------------------------------- */

interface AuthorRow {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  followerCount: number;
  storyCount: number;
}

/**
 * Writers worth following, for the onboarding step that asks.
 *
 * Ranked by how much of their listed work carries a genre the reader named,
 * then by followers, then by how much they have published -- so a reader who
 * has chosen genres is shown people who write them, and one who has not is
 * shown the platform's most-followed writers instead of an empty step. Anyone
 * the reader already follows is left out, as is the reader themselves and any
 * suspended account.
 *
 * This is the reason the onboarding author picker no longer needs a fixture:
 * `GET /api/users/:username` could always serve a profile and following was
 * always real, but nothing answered "who should I follow?" until now.
 */
export async function suggestAuthors(
  userId: string,
  limit: number,
): Promise<AuthorSuggestion[]> {
  const plan = db.raw.sql`
    WITH "preferred" AS (
      SELECT "genreId" FROM "auth"."genrePreference" WHERE "userId" = ${userId}
    ),
    "authored" AS (
      SELECT s."authorId",
             COUNT(*)::int AS "stories",
             COUNT(*) FILTER (
               WHERE EXISTS (
                 SELECT 1
                   FROM "content"."storyGenre" AS sg
                   JOIN "preferred" AS p ON p."genreId" = sg."genreId"
                  WHERE sg."storyId" = s."id"
               )
             )::int AS "matches"
        FROM "content"."story" AS s
       WHERE s."source" = 'SCRIBE'
         AND s."listedAt" IS NOT NULL
         AND s."authorId" <> ${userId}
       GROUP BY s."authorId"
    )
    SELECT u."id", u."username", u."displayName", u."avatarUrl",
           a."stories" AS "storyCount",
           (SELECT COUNT(*)
              FROM "engagement"."follow" AS f
             WHERE f."followingId" = u."id")::int AS "followerCount"
      FROM "authored" AS a
      JOIN "auth"."user" AS u ON u."id" = a."authorId"
     WHERE u."suspendedAt" IS NULL
       AND NOT EXISTS (
             SELECT 1 FROM "engagement"."follow" AS f
              WHERE f."followerId" = ${userId}
                AND f."followingId" = u."id"
           )
     ORDER BY a."matches" DESC, "followerCount" DESC, a."stories" DESC,
              u."id" DESC
     LIMIT ${limit}
  `.returnsRow({
    id: "pg/text@1",
    username: "pg/text@1",
    displayName: { codecId: "pg/text@1", nullable: true },
    avatarUrl: { codecId: "pg/text@1", nullable: true },
    storyCount: "pg/int4@1",
    followerCount: "pg/int4@1",
  }).build();

  const rows = (await db.runtime().query(plan)) as AuthorRow[];

  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    followerCount: row.followerCount,
    storyCount: row.storyCount,
  }));
}
