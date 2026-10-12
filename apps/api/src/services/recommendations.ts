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
 * whole of it: eight weighted terms summed in SQL and ordered there. Ranking
 * in the database rather than in this process is not an optimisation for its
 * own sake -- a JS ranker would have to load every listed story to sort them,
 * which is the query that stops working first. The cost is that the weights
 * live in SQL text; `WEIGHTS` below is where they are named and the only place
 * they are written down.
 *
 * **One term reads what the stories say rather than how they are tagged.**
 * `similar` compares each candidate with the stories the reader liked, using
 * the passage vectors `services/ai/embeddings.ts` stored. It is arithmetic on
 * stored rows: no model is called to rank, so the term costs no tokens, cannot
 * be taken down by a model server, and is as repeatable as the other seven. A
 * story nobody has embedded yet -- the backfill is what embeds them -- scores
 * zero on it and is ranked by the rest, as it was before this term existed.
 *
 * **The score is deterministic.** No clock beyond a 30-day freshness window,
 * no randomness, no per-request shuffle, no model call. Two identical requests a second apart
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
 * **The page is not simply the top of the ranking.** Stories that resemble
 * each other score alike and so arrive together; `recommendation-diversity.ts`
 * caps how many one author or one genre may take, over a pool a few times the
 * size of the page. The ranking decides how good a story is, the caps decide
 * which of the best share a shelf, and neither knows about the other.
 *
 * **Nothing already met comes back.** A story on any shelf, at any reading
 * position, or carrying a rating from this reader is excluded outright, along
 * with the reader's own work. Shelving something is a decision already taken;
 * repeating it back as a suggestion is the recommender's most annoying
 * failure mode and the cheapest to prevent.
 */

import { db } from "../prisma/db.js";
import { loadAiEmbedConfig } from "./ai/config.js";
import { embeddingSpace } from "./ai/embeddings.js";
import { diversify } from "./recommendation-diversity.js";
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
 * | `similar`    |  2.5 | reads like the nearest story they liked          |
 * | `length`     |  1.5 | matches their preferred length                   |
 * | `quality`    |  1.5 | scaled from the story's average rating           |
 * | `popularity` |  0.2 | times the log of views plus twice likes          |
 * | `fresh`      |  1.0 | listed within `FRESH_DAYS`                       |
 *
 * `similar` is weighted with `history` because it is the same kind of
 * evidence -- inferred from what they shelved, read and rated -- reached by a
 * different route: `history` asks whether the tags agree, `similar` whether
 * the prose does. Unlike the others it is rarely paid in full; see
 * `AiEmbedConfig.recommendMinSimilarity` for the band it is scaled across.
 *
 * Changing a number here changes the ranking and nothing else; every one of
 * them is bound into the statement as a parameter rather than written into it.
 */
const WEIGHTS = {
  genre: 4.0,
  history: 2.5,
  follow: 3.0,
  similar: 2.5,
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

/**
 * How many liked stories a candidate is compared against: the most recently
 * touched ones that have vectors.
 *
 * A bound on the work -- every candidate is measured against every anchor --
 * and a statement about taste: what somebody finished last month says more
 * about what they want next than what they shelved three years ago.
 */
const MAX_ANCHORS = 20;

/**
 * How much deeper than the page the ranking is read, so the diversity caps
 * have something to choose from. Four pages is enough that a prolific author
 * filling the top of the ranking still leaves a full page behind them.
 */
const POOL_FACTOR = 4;

/**
 * How a reader came to like the story a recommendation resembles, in the
 * order the wording prefers when there was more than one way: a high rating
 * is the strongest thing they said about it, a shelf the most recognisable.
 *
 * Numbers because SQL picks the smallest. `OTHER` marks signal rows that are
 * not a reason to call a story liked -- a middling or low rating -- and is
 * never the smallest for a story that qualifies as an anchor at all.
 */
const VIA = {
  RATED: 1,
  FINISHED: 2,
  READING: 3,
  HISTORY: 4,
  WANT_TO_READ: 5,
  OTHER: 9,
} as const;

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
  similarScore: unknown;
  lengthScore: unknown;
  qualityScore: unknown;
  popularityScore: unknown;
  freshScore: unknown;
  score: unknown;
  /** The liked story this one is nearest to; empty when there is none. */
  similarTitle: string;
  /** One of `VIA`, or 0 when there is none. */
  similarVia: number;
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
 *   Each row also says how the story was met (`via`) and when (`at`), which
 *   only the similarity term reads.
 * - `taste` — those weights collapsed onto genres. The inferred signal.
 * - `scale` — the largest genre weight, so `taste` can be normalised into
 *   [-1, 1] and a reader with four hundred shelved books does not score
 *   differently from one with four. Floored at 1 so it can never divide by
 *   zero or amplify a single row into certainty.
 * - `passage` — the stored vectors that may be compared: the configured
 *   model and width only, because a vector from another model is a point in
 *   another space, and published chapters only, so a chapter embedded and then
 *   unpublished stops shaping anybody's shelf. Not materialised, so it is a
 *   filter the two reads below share rather than a copy of the table.
 * - `anchor` — the stories the reader liked (their signal weights sum above
 *   zero) that are still listed and have vectors, each as the average of its
 *   passages, most recently touched first, at most `MAX_ANCHORS`. Disliked
 *   stories are not anchors: this term only ever adds, because "unlike a
 *   story you rated badly" is not something a card can say.
 * - `candidate` — listed Scribe stories the reader has not met and did not
 *   write. `NOT EXISTS` against `signal` rather than a `NOT IN`, so a null
 *   cannot swallow the whole set.
 * - `measured` — each candidate's raw inputs, including its word count from a
 *   lateral over published chapters. One lateral per candidate row, which is
 *   the shape `services/analytics.ts` uses and for the same reason: the
 *   alternative multiplies rows against the genre join. Two more laterals
 *   average the candidate's own passages and find the one anchor nearest that
 *   average -- cosine, the distance the vectors were trained for. The nearest
 *   anchor rather than the reader's average taste, for two reasons: a reader
 *   who likes both heist novels and pastoral romance has no meaningful
 *   midpoint, and "similar to this one book" is a reason a card can give.
 *   Two guards there: a candidate is only averaged when there is an anchor
 *   to compare it with, and a `NaN` similarity is read as zero -- pgvector
 *   answers `NaN` for a zero vector, and `NaN` sorts above every number, so
 *   unguarded an empty vector would score full marks.
 * - `weighted` — the eight terms. Similarity is scaled across the band
 *   between `floor` and `full` and clamped, since whole stories all sit close
 *   together and only the top of the range means anything. A separate step only because SQL cannot
 *   reference a select-list alias from the same select list.
 *
 * The whole thing is one statement, so the database sees one plan and this
 * process never holds more than the rows it asked for.
 *
 * What will not scale as written: every candidate's vector is averaged from
 * its passages on every request. That is a few hundred rows today. When it is
 * not, the fix is a stored vector per story, written by the same pass that
 * embeds its chapters -- the statement keeps its shape and `passage` becomes a
 * table.
 */
async function rankStories(
  userId: string,
  contentLength: ContentLength,
  limit: number,
): Promise<RankedRow[]> {
  // No embedder configured means no comparable vectors: the empty model name
  // matches no row, every similarity is zero, and the other terms rank alone.
  const space = embeddingSpace();
  const model = space?.model ?? "";
  const dimensions = space?.dimensions ?? 0;

  const { recommendMinSimilarity: floor, recommendFullSimilarity: full } =
    loadAiEmbedConfig();
  // Guarded so a misconfigured pair cannot divide by zero or invert the term.
  const band = Math.max(full - floor, 0.01);

  const plan = db.raw.sql`
    WITH "preferred" AS (
      SELECT "genreId" FROM "auth"."genrePreference" WHERE "userId" = ${userId}
    ),
    "signal" AS (
      SELECT "storyId", 1.0::numeric AS "weight",
             (CASE "status" WHEN 'FINISHED' THEN ${VIA.FINISHED}
                            WHEN 'READING' THEN ${VIA.READING}
                            ELSE ${VIA.WANT_TO_READ} END)::int AS "via",
             "updatedAt" AS "at"
        FROM "library"."libraryEntry" WHERE "userId" = ${userId}
      UNION ALL
      SELECT "storyId", 1.0::numeric, ${VIA.HISTORY}::int, "lastReadAt"
        FROM "engagement"."readingHistory" WHERE "userId" = ${userId}
      UNION ALL
      SELECT "storyId",
             CASE WHEN "rating" >= 4 THEN 2.0::numeric
                  WHEN "rating" <= 2 THEN -1.5::numeric
                  ELSE 0.0::numeric END,
             (CASE WHEN "rating" >= 4 THEN ${VIA.RATED}
                   ELSE ${VIA.OTHER} END)::int,
             "updatedAt"
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
    "passage" AS NOT MATERIALIZED (
      SELECT pc."storyId", pc."embedding"
        FROM "ai"."chapterChunk" AS pc
        JOIN "content"."chapter" AS pch ON pch."id" = pc."chapterId"
       WHERE pc."model" = ${model}
         AND pc."dimensions" = ${dimensions}
         AND pc."embedding" IS NOT NULL
         AND pch."publishedAt" IS NOT NULL
    ),
    "liked" AS (
      SELECT sig."storyId", MIN(sig."via") AS "via", MAX(sig."at") AS "at"
        FROM "signal" AS sig
       GROUP BY sig."storyId"
      HAVING SUM(sig."weight") > 0
    ),
    "anchor" AS (
      SELECT l."storyId", l."via", ls."title", av."vector"
        FROM "liked" AS l
        JOIN "content"."story" AS ls
          ON ls."id" = l."storyId" AND ls."listedAt" IS NOT NULL
        JOIN LATERAL (
              SELECT AVG(p."embedding") AS "vector"
                FROM "passage" AS p
               WHERE p."storyId" = l."storyId"
             ) AS av ON av."vector" IS NOT NULL
       ORDER BY l."at" DESC, l."storyId" DESC
       LIMIT ${MAX_ANCHORS}
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
             COALESCE(w."words", 0) AS "words",
             COALESCE(NULLIF(near."similarity", 'NaN'::float8), 0)::numeric
               AS "similarity",
             COALESCE(near."title", '') AS "similarTitle",
             COALESCE(near."via", 0)::int AS "similarVia"
        FROM "candidate" AS c
        LEFT JOIN LATERAL (
              SELECT SUM(ch."wordCount")::int AS "words"
                FROM "content"."chapter" AS ch
               WHERE ch."storyId" = c."id"
                 AND ch."publishedAt" IS NOT NULL
             ) AS w ON TRUE
        LEFT JOIN LATERAL (
              SELECT AVG(p."embedding") AS "vector"
                FROM "passage" AS p
               WHERE p."storyId" = c."id"
                 AND EXISTS (SELECT 1 FROM "anchor")
             ) AS cv ON TRUE
        LEFT JOIN LATERAL (
              SELECT a."title", a."via",
                     (1 - (cv."vector" <=> a."vector"))::float8 AS "similarity"
                FROM "anchor" AS a
               WHERE cv."vector" IS NOT NULL
               ORDER BY cv."vector" <=> a."vector", a."storyId"
               LIMIT 1
             ) AS near ON TRUE
    ),
    "weighted" AS (
      SELECT m."id",
             (m."hits" * ${WEIGHTS.genre}::numeric) AS "genreScore",
             (LEAST(GREATEST(m."taste" / (SELECT "max" FROM "scale"), -1.0), 1.0)
               * ${WEIGHTS.history}::numeric) AS "historyScore",
             (CASE WHEN m."followed" THEN ${WEIGHTS.follow}::numeric
                   ELSE 0::numeric END) AS "followScore",
             (LEAST(GREATEST((m."similarity" - ${floor}::numeric)
                               / ${band}::numeric, 0::numeric), 1::numeric)
               * ${WEIGHTS.similar}::numeric) AS "similarScore",
             m."similarTitle", m."similarVia",
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
    SELECT "id", "genreScore", "historyScore", "followScore", "similarScore",
           "lengthScore", "qualityScore", "popularityScore", "freshScore",
           ("genreScore" + "historyScore" + "followScore" + "similarScore"
             + "lengthScore" + "qualityScore" + "popularityScore"
             + "freshScore") AS "score",
           "similarTitle", "similarVia"
      FROM "weighted"
     ORDER BY "score" DESC, "id" DESC
     LIMIT ${limit}
  `.returnsRow({
    id: "pg/text@1",
    genreScore: "pg/numeric@1",
    historyScore: "pg/numeric@1",
    followScore: "pg/numeric@1",
    similarScore: "pg/numeric@1",
    lengthScore: "pg/numeric@1",
    qualityScore: "pg/numeric@1",
    popularityScore: "pg/numeric@1",
    freshScore: "pg/numeric@1",
    score: "pg/numeric@1",
    similarTitle: "pg/text@1",
    similarVia: "pg/int4@1",
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
 *
 * The similarity sentence names the one story the score was measured against
 * and where the reader knows it from, both read off the row that earned the
 * points. It says "similar", not "similar in tone": the vectors measure what
 * the prose is about, and a card should not claim more than the code can
 * show.
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
    { score: toNumber(row.similarScore), text: similarReason(row) },
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

/**
 * "Similar to X", and how the reader knows X.
 *
 * The shelf names are the ones the library page prints. With no nearest story
 * there is no score either, so the fallback is never the winning sentence.
 */
function similarReason(row: RankedRow): string {
  const title = row.similarTitle;
  if (title === "") return "Picked for you";

  switch (row.similarVia) {
    case VIA.RATED:
      return `Similar to ${title}, which you rated highly`;
    case VIA.FINISHED:
      return `Similar to ${title} on your Finished shelf`;
    case VIA.READING:
      return `Similar to ${title} on your Reading shelf`;
    case VIA.WANT_TO_READ:
      return `Similar to ${title} on your Want to read shelf`;
    default:
      return `Similar to ${title}, which you have been reading`;
  }
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
 * simply absent from the map and drops out here.
 *
 * The ranking is read `POOL_FACTOR` pages deep and the page is chosen from it
 * by `diversify`, on the author and genres of the hydrated story -- the ones
 * printed on its card, so a reader counting Fantasy covers on the shelf counts
 * what the cap counted.
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
  const ranked = await rankStories(
    userId,
    contentLength,
    limit * POOL_FACTOR,
  );

  const stories = await getStoriesByIds(
    ranked.map((row) => row.id),
    userId,
  );

  const pool: Array<{ row: RankedRow; story: Story }> = [];
  for (const row of ranked) {
    const story = stories.get(row.id);
    if (story) pool.push({ row, story });
  }

  const page = diversify(pool, limit, ({ story }) => ({
    authorId: story.author.id,
    genreIds: story.genres.map((genre) => genre.id),
  }));

  return {
    basis: "personal",
    items: page.map(({ row, story }) => ({
      story,
      score: round(toNumber(row.score)),
      reason: reasonFor(row, story, preferredGenreIds, contentLength),
    })),
  };
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
