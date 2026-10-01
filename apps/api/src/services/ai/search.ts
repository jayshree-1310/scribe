/**
 * Search over meaning, and over meaning and keywords together.
 *
 * The keyword search in `services/stories.ts` is an `ilike` on title and
 * author: it finds "The Grief Diaries" for "grief" and never finds the novel
 * whose fourth chapter is the best thing anyone has written about losing a
 * brother, because that chapter never uses the word. Semantic search finds the
 * novel and, given "Okonkwo", finds nothing at all -- a name has no meaning to
 * embed. Neither is sufficient, so this file runs both and fuses them.
 *
 * ## The path a query takes
 *
 * 1. **Embed it** (`embedQuery`), through the same embedder the corpus was
 *    embedded with, and cached by text so paging through results or toggling
 *    a filter does not pay for the same vector twice.
 * 2. **Nearest passages** (`nearestPassages`): an ANN query over
 *    `ai.chapterChunk`, filtered in SQL by model, source, genre and visibility.
 * 3. **Passages become stories** (`rankStories` in `search-ranking.ts`): drop
 *    anything under the similarity floor, rank each story by its best passage.
 * 4. **Keyword ranking** (`keywordRanking`): `listStories`, unchanged.
 * 5. **Fuse** the two rankings with reciprocal-rank fusion (`fuseRankings`).
 * 6. **Hydrate and re-authorise**: stories through `getStoriesByIds`, passages
 *    through `findVisibleChapterIds` -- see below.
 *
 * The result is `listStories`' own `Page<Story>`, with two fields added to
 * each item, so every component that draws a story list draws this one too.
 *
 * ## Retrieval inherits every authorisation rule of the data
 *
 * A vector index does not know a draft is a draft. The HNSW graph is built over
 * every row in the table, and a nearest-neighbour query left to itself returns
 * the nearest rows, published or not -- which would quote unpublished prose to
 * a stranger in the passage under a search result. So visibility is applied
 * twice, for two different reasons:
 *
 * - **In the query**, as a pre-filter. Not because it is the authority, but
 *   because of `LIMIT`: an index scan that returns the hundred nearest rows and
 *   *then* drops the forty that are drafts has returned sixty, and on a corpus
 *   where one prolific author's drafts happen to sit near the query it could
 *   return none. Filtering in the scan, with pgvector's iterative scan
 *   switched on, keeps walking the graph until a hundred *visible* rows are
 *   found.
 * - **After retrieval**, through `services/stories.ts`, which is where the
 *   rule lives. Every story goes through `getStoriesByIds` (`visibleTo`) and
 *   every quoted passage through `findVisibleChapterIds`; anything they do not
 *   return is dropped. If the SQL above ever drifts from the rule, it is this
 *   that holds -- and `ai-search.test.ts` proves it does by searching as a
 *   stranger for a draft that is the best match there is.
 *
 * ## What this does not search
 *
 * Catalogue editions by keyword. `listStories` is the keyword half, and it has
 * always been authored stories only -- the catalogue is `/api/books`, with a
 * different shape. So `source=CATALOGUE` is semantic only, and finds whatever
 * catalogue chapters have been embedded (today: none).
 */

import { createHash } from "node:crypto";
import { HttpError } from "../../lib/http-error.js";
import { logger } from "../../lib/logger.js";
import { connectRedis, redis } from "../../lib/redis.js";
import { db } from "../../prisma/db.js";
import {
  MAX_PAGE_SIZE,
  findVisibleChapterIds,
  getStoriesByIds,
  listStories,
  type Page,
  type Story,
  type StorySource,
} from "../stories.js";
import { loadAiEmbedConfig } from "./config.js";
import { aiEmbedder } from "./provider.js";
import {
  excerptOf,
  fuseRankings,
  rankStories,
  type PassageHit,
  type StoryHit,
} from "./search-ranking.js";
import type { AiEmbedder } from "./types.js";

/** Keyed on in every usage record this feature produces. */
const FEATURE = "search.query";

export const SEARCH_MODES = ["hybrid", "semantic"] as const;

export type SearchMode = (typeof SEARCH_MODES)[number];

/** Long enough for a sentence describing a book; short enough to be a query. */
export const QUERY_LIMIT = 200;

/**
 * Passages the vector query returns.
 *
 * A candidate pool, not a result count: several passages collapse into one
 * story, and the floor drops more. A hundred windows is roughly eight
 * chapters' worth, enough that a long novel matching strongly cannot crowd
 * every other story out of the pool.
 *
 * `SET LOCAL hnsw.ef_search` in `nearestPassages` must be at least this --
 * HNSW returns at most `ef_search` rows per scan, and pgvector's default of 40
 * would silently truncate a `LIMIT 100` to forty.
 */
const CANDIDATE_PASSAGES = 100;

/** How long a query's vector is remembered. A day: queries repeat, models do not change hourly. */
const QUERY_CACHE_SECONDS = 60 * 60 * 24;

export interface SearchQuery {
  q: string;
  genreId?: string | undefined;
  source?: StorySource | undefined;
  mode: SearchMode;
  page: number;
  limit: number;
}

/** A passage quoted under a result, so the reader sees *why* it matched. */
export interface SearchPassage {
  chapterId: string;
  chapterNumber: number;
  chapterTitle: string;
  /** A slice of the matched window; see `excerptOf`. */
  excerpt: string;
  /** Cosine similarity to the query, rounded for display. */
  similarity: number;
}

/**
 * Where a result came from, so nothing about the ranking is a black box.
 *
 * Null on the empty-query fallback, where nothing was ranked against a query.
 */
export interface SearchMatch {
  /** 1-based position in the keyword ranking, or null if keywords missed it. */
  keywordRank: number | null;
  /** 1-based position in the semantic ranking, or null if meaning missed it. */
  semanticRank: number | null;
  /** The fused score. Comparable within one response, meaningless across them. */
  score: number;
}

export interface SearchResult extends Story {
  /** Empty when the story matched on keywords alone. */
  passages: SearchPassage[];
  match: SearchMatch | null;
}

/**
 * What actually ran, which is not always what was asked for.
 *
 * - `list`: the query was empty, so this is `listStories` with the filters.
 * - `hybrid` / `semantic`: what was requested.
 * - `keyword`: hybrid was requested and the embedder was unavailable, so the
 *   keyword half answered alone. Reported rather than hidden, so the UI can
 *   say so instead of presenting worse results as the usual ones.
 */
export type SearchBasis = "list" | "hybrid" | "semantic" | "keyword";

export interface SearchPage extends Page<SearchResult> {
  basis: SearchBasis;
}

/* Step 1: the query vector ----------------------------------------------- */

/**
 * The query's vector, from cache when this exact text has been embedded by
 * this exact model before.
 *
 * The key carries the model and width as well as the text, for the reason the
 * chunk rows carry them: a vector from another model is not a stale answer but
 * an answer in a different space, and comparing it against this corpus would
 * produce distances that mean nothing.
 *
 * Only whitespace is normalised. Lower-casing would let "Grief" and "grief"
 * share a cache entry, but the model embeds them slightly differently, and a
 * cache that returns a vector for text other than the text asked about is
 * quietly wrong rather than quietly fast.
 *
 * The cache is a convenience. Redis failing is logged and ignored -- a slower
 * search is better than a failed one.
 */
async function embedQuery(
  text: string,
  embedder: AiEmbedder,
  signal?: AbortSignal,
): Promise<string> {
  const key =
    "ai:search:query:" +
    createHash("sha256")
      .update(`${embedder.model}\u0000${embedder.dimensions}\u0000${text}`)
      .digest("hex");

  try {
    await connectRedis();
    const cached = await redis.get(key);
    if (cached) return cached;
  } catch (error) {
    logger.warn({ err: error }, "search query cache read failed");
  }

  const result = await embedder.embed({
    feature: FEATURE,
    texts: [text],
    ...(signal ? { signal } : {}),
  });

  const vector = result.vectors[0];
  // The same loud failure as the backfill's, for the same reason: a vector of
  // the wrong width is a question about a different corpus.
  if (!vector || vector.length !== embedder.dimensions) {
    throw HttpError.upstream(
      `The embedding model returned ${vector?.length ?? 0} dimensions, ` +
        `but this database stores ${embedder.dimensions}. ` +
        "Check AI_EMBED_MODEL and AI_EMBED_DIMENSIONS.",
    );
  }

  const literal = `[${vector.join(",")}]`;

  try {
    await redis.set(key, literal, { EX: QUERY_CACHE_SECONDS });
  } catch (error) {
    logger.warn({ err: error }, "search query cache write failed");
  }

  return literal;
}

/* Step 2: nearest passages ----------------------------------------------- */

interface Filters {
  genreId: string | null;
  source: StorySource | null;
}

/**
 * The passages nearest the query that this caller may read, nearest first.
 *
 * **`<=>` and nothing else.** It is cosine distance, the operator the HNSW
 * index was built for (`vector_cosine_ops`, see `ensureEmbeddingIndex`). Order
 * by any other distance and Postgres silently scans the table instead.
 *
 * **The visibility predicate** mirrors `visibleTo` and `chaptersVisibleTo` in
 * `services/stories.ts`: a story that is listed or the caller's own, a chapter
 * that is published or the caller's own. It is the pre-filter described in the
 * file header, not the authority -- `search()` re-checks every row through
 * those functions before anything is returned.
 *
 * **Model and width are filtered on**, because a row embedded by a model the
 * service is no longer configured with is a point in another space. Those rows
 * are not wrong, only unreachable until the backfill re-embeds them.
 *
 * Every `${}` is a bound parameter, never a fragment of SQL, so optional
 * filters are written as `(param = '' OR ...)` rather than assembled. The
 * empty string stands in for "absent" because the raw lane binds no nulls, and
 * it is safe as a sentinel: no id, author or source is ever empty, so an
 * anonymous caller's `authorId = ''` matches nothing, which is what anonymous
 * means here.
 *
 * Runs in a transaction only so that the two `SET LOCAL`s apply to this query
 * and nothing else on the pooled connection:
 *
 * - `hnsw.ef_search = 100`, so one scan can return `CANDIDATE_PASSAGES` rows.
 * - `hnsw.iterative_scan = relaxed_order` (pgvector 0.8+): when the filters
 *   reject rows the index returned, keep scanning rather than stopping short.
 *   `relaxed_order` permits slightly out-of-order results in exchange for
 *   speed, and `rankStories` re-sorts anyway. On an older pgvector the setting
 *   is an unknown placeholder and is ignored, which degrades to fewer
 *   candidates rather than to an error.
 *
 * At today's corpus size Postgres will usually ignore the index and scan
 * exactly, which is both correct and faster for a few hundred rows; the
 * settings matter from the day it stops doing that.
 */
async function nearestPassages(
  vector: string,
  embedder: AiEmbedder,
  filters: Filters,
  viewerId: string | null,
): Promise<PassageHit[]> {
  const viewer = viewerId ?? "";
  const source = filters.source ?? "";
  const genreId = filters.genreId ?? "";

  const plan = db.raw.sql`
    SELECT c."storyId",
           c."chapterId",
           ch."chapterNumber",
           ch."title" AS "chapterTitle",
           c."text",
           (1 - (c."embedding" <=> ${vector}::vector))::float8 AS "similarity"
      FROM "ai"."chapterChunk" AS c
      JOIN "content"."chapter" AS ch ON ch."id" = c."chapterId"
      JOIN "content"."story" AS s ON s."id" = c."storyId"
     WHERE c."model" = ${embedder.model}
       AND c."dimensions" = ${embedder.dimensions}
       AND c."embedding" IS NOT NULL
       AND (s."listedAt" IS NOT NULL OR s."authorId" = ${viewer})
       AND (ch."publishedAt" IS NOT NULL OR s."authorId" = ${viewer})
       AND (${source} = '' OR s."source" = ${source})
       AND (
         ${genreId} = ''
         OR EXISTS (
           SELECT 1
             FROM "content"."storyGenre" AS sg
            WHERE sg."storyId" = c."storyId"
              AND sg."genreId" = ${genreId}
         )
       )
     ORDER BY c."embedding" <=> ${vector}::vector
     LIMIT ${CANDIDATE_PASSAGES}
  `
    .returnsRow({
      storyId: "pg/text@1",
      chapterId: "pg/text@1",
      chapterNumber: "pg/int4@1",
      chapterTitle: "pg/text@1",
      text: "pg/text@1",
      similarity: "pg/float8@1",
    })
    .build();

  return db.transaction(async (tx) => {
    await tx.query(
      db.raw.sql`SET LOCAL hnsw.ef_search = 100`.affectedCount().build(),
    );
    await tx.query(
      db.raw.sql`SET LOCAL hnsw.iterative_scan = relaxed_order`
        .affectedCount()
        .build(),
    );

    return (await tx.query(plan)) as PassageHit[];
  });
}

/**
 * Steps 1-3: the semantic ranking.
 *
 * The embedder is resolved here rather than at module scope so that a server
 * with no embedding configuration fails this call with a 503, not the process
 * at import.
 */
async function semanticRanking(
  q: string,
  filters: Filters,
  viewerId: string | null,
  signal?: AbortSignal,
): Promise<StoryHit[]> {
  const embedder = aiEmbedder();
  const vector = await embedQuery(q, embedder, signal);
  const hits = await nearestPassages(vector, embedder, filters, viewerId);

  return rankStories(hits, loadAiEmbedConfig().searchMinSimilarity);
}

/* Step 4: the keyword ranking -------------------------------------------- */

/**
 * The existing keyword search, ranked as it already ranks.
 *
 * Not reimplemented: `listStories` is the keyword search, with its own
 * word-by-word author matching and its own visibility rule, and a second copy
 * here would drift from the search box everybody else uses. Its order -- by
 * engagement, among the stories that matched -- is the rank fusion consumes.
 *
 * Skipped for `source=CATALOGUE`; see the file header.
 */
async function keywordRanking(
  q: string,
  filters: Filters,
  viewerId: string | null,
): Promise<string[]> {
  if (filters.source === "CATALOGUE") return [];

  const page = await listStories(
    {
      search: q,
      genreId: filters.genreId ?? undefined,
      sort: "trending",
      page: 1,
      limit: MAX_PAGE_SIZE,
    },
    viewerId,
  );

  return page.items.map((story) => story.id);
}

/* Steps 5-6: fuse, hydrate, re-authorise --------------------------------- */

/**
 * Whether a semantic failure should degrade hybrid search rather than fail it.
 *
 * Only for the embedder being unreachable or misbehaving -- the 5xx family the
 * provider seam raises. A keyword search is a worse answer than a hybrid one,
 * but a much better one than an error page because a model container is down.
 * Anything else is a bug and propagates.
 */
function isEmbedderOutage(error: unknown): boolean {
  return error instanceof HttpError && error.status >= 500;
}

function toPassage(hit: PassageHit, q: string): SearchPassage {
  return {
    chapterId: hit.chapterId,
    chapterNumber: hit.chapterNumber,
    chapterTitle: hit.chapterTitle,
    excerpt: excerptOf(hit.text, q),
    similarity: Math.round(hit.similarity * 1000) / 1000,
  };
}

function paginate<T>(items: T[], page: number, limit: number): Page<T> {
  const total = items.length;
  return {
    items: items.slice((page - 1) * limit, page * limit),
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
    hasMore: page * limit < total,
  };
}

/**
 * Hybrid (or purely semantic) search, in `listStories`' page shape.
 *
 * An empty query is not a search: it falls back to `listStories` with the same
 * filters, so turning the toggle on with nothing typed shows the ordinary list
 * rather than nothing -- and costs no model call.
 */
export async function search(
  query: SearchQuery,
  viewerId: string | null,
  signal?: AbortSignal,
): Promise<SearchPage> {
  const q = query.q.replace(/\s+/g, " ").trim();
  const filters: Filters = {
    genreId: query.genreId ?? null,
    source: query.source ?? null,
  };

  if (q === "") {
    if (filters.source === "CATALOGUE") {
      return { ...paginate([], query.page, query.limit), basis: "list" };
    }

    const listed = await listStories(
      {
        genreId: filters.genreId ?? undefined,
        sort: "trending",
        page: query.page,
        limit: query.limit,
      },
      viewerId,
    );

    return {
      ...listed,
      items: listed.items.map((story) => ({ ...story, passages: [], match: null })),
      basis: "list",
    };
  }

  const keyword =
    query.mode === "hybrid"
      ? keywordRanking(q, filters, viewerId)
      : Promise.resolve([]);

  let semantic: StoryHit[];
  let basis: SearchBasis = query.mode;
  try {
    semantic = await semanticRanking(q, filters, viewerId, signal);
  } catch (error) {
    if (query.mode !== "hybrid" || !isEmbedderOutage(error)) {
      // Settle the keyword half before leaving, so its rejection (if any) is
      // not reported as unhandled after this one has already been thrown.
      await keyword.catch(() => undefined);
      throw error;
    }
    logger.warn({ err: error }, "semantic search unavailable; keyword only");
    semantic = [];
    basis = "keyword";
  }

  const keywordIds = await keyword;
  const semanticIds = semantic.map((hit) => hit.storyId);
  const fused = fuseRankings([keywordIds, semanticIds]);

  /*
   * The authoritative visibility check, after which nothing invisible exists.
   * Hydrating every candidate rather than one page is what lets `total` be the
   * true count: a row dropped here must not leave a hole in page two. The
   * candidate pool is bounded (`MAX_PAGE_SIZE` + `CANDIDATE_PASSAGES`), and
   * `getStoriesByIds` loads a batch in a fixed number of queries.
   */
  const passages = semantic.flatMap((hit) => hit.passages);
  const [stories, readable] = await Promise.all([
    getStoriesByIds(
      fused.map((hit) => hit.id),
      viewerId,
    ),
    findVisibleChapterIds(
      [...new Set(passages.map((hit) => hit.chapterId))],
      viewerId,
    ),
  ]);

  const semanticById = new Map(semantic.map((hit) => [hit.storyId, hit]));

  const results: SearchResult[] = [];
  for (const hit of fused) {
    const story = stories.get(hit.id);
    if (!story) continue;
    if (filters.source !== null && story.source !== filters.source) continue;

    const quoted = (semanticById.get(hit.id)?.passages ?? [])
      .filter((passage) => readable.has(passage.chapterId))
      .map((passage) => toPassage(passage, q));

    const [keywordRank, semanticRank] = hit.ranks;

    // A story that was here only for a passage the caller may not read has no
    // reason left to be here at all.
    if ((keywordRank ?? null) === null && quoted.length === 0) continue;

    results.push({
      ...story,
      passages: quoted,
      match: {
        keywordRank: keywordRank ?? null,
        semanticRank: semanticRank ?? null,
        score: Math.round(hit.score * 1e6) / 1e6,
      },
    });
  }

  return { ...paginate(results, query.page, query.limit), basis };
}
