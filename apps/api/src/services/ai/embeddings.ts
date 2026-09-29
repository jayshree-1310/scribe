/**
 * Turning chapters into vectors, and keeping them from being turned twice.
 *
 * This is the first piece of retrieval infrastructure and it shows a user
 * nothing at all. What it produces is the table Tasks AI 8 through AI 11 read:
 * one row per overlapping window of a chapter (`chunking.ts`), carrying the
 * text, an embedding of it, and enough metadata that a search can filter
 * without joining back to the story.
 *
 * ## Idempotency is the design, not an optimisation
 *
 * Embedding is the most duplicated cost in the AI backlog. The corpus does not
 * change much and the backfill is re-run every time somebody adds a story, so
 * the common case for this file is *being asked to do work that has already
 * been done*. Three things make that free:
 *
 * - **Chunking is deterministic.** The same prose always yields the same
 *   windows in the same order with the same hashes.
 * - **The chapter fast path.** If every stored row for a chapter already
 *   matches the chunk it would produce -- same ordinal, same hash, same model,
 *   same width -- nothing is read from a model and nothing is written to the
 *   database. This is the path a re-run takes for the entire corpus.
 * - **Per-chunk reuse.** When a chapter *has* changed, only the windows whose
 *   text changed are embedded. Fixing a typo in one paragraph re-embeds the one
 *   or two windows it falls in, not the chapter; the rest keep the vectors they
 *   already had. This is why the hash is of the chunk's own text rather than of
 *   the whole chapter -- a chapter-level hash would make every edit cost a full
 *   re-embedding, which is the bill this column exists to avoid.
 *
 * ## Why there is raw SQL here
 *
 * `embedding` is a `vector(768)` column and the contract does not describe it:
 * the Prisma Next pgvector extension package is not published for this
 * release, so the migration adds the column with explicit SQL and this file
 * reads and writes it through `db.raw.sql`. Everything else about the row goes
 * through the same lane simply because a row half-written by the ORM and
 * half-written by SQL would be two statements where one will do.
 *
 * Vectors cross the wire as pgvector's own text form -- `[0.1,0.2,...]` --
 * which is what `::vector` parses and what `::text` produces. That is also
 * what makes reuse cheap: an unchanged window's vector is copied back out and
 * in as a string, without ever being parsed into floats or sent to a model.
 *
 * ## What this does not do
 *
 * There is no ANN index yet and no search. Both are Task AI 8, which is also
 * where the rule that **retrieval inherits every authorisation rule of the
 * data** has to be enforced: a vector index does not know a draft is a draft.
 * Nothing here queries the table, so nothing here can leak one -- but the
 * backfill still declines to embed unpublished chapters by default, because
 * the cheapest way to not leak a draft is to not have it in the index.
 */

import { randomUUID } from "node:crypto";
import { HttpError } from "../../lib/http-error.js";
import { db } from "../../prisma/db.js";
import { chunkChapter, type Chunk } from "./chunking.js";
import { loadAiEmbedConfig } from "./config.js";
import { aiEmbedder } from "./provider.js";
import type { AiEmbedder } from "./types.js";

/** Keyed on in every usage record this feature produces. */
const FEATURE = "embeddings.chapter";

/** What one chapter's pass cost and changed. */
export interface ChapterEmbedding {
  chapterId: string;
  /** Windows the chapter currently produces. */
  chunks: number;
  /** Windows that needed a model call. */
  embedded: number;
  /** Windows whose vector was carried over from a stored row. */
  reused: number;
  /** True when the stored rows already matched and nothing was written. */
  unchanged: boolean;
  tokensUsed: number;
}

/* Reading what is already stored ----------------------------------------- */

interface StoredChunk {
  ordinal: number;
  contentHash: string;
  model: string;
  dimensions: number;
  /**
   * pgvector's text form, kept as a string; see the file header.
   *
   * Nullable because the column is -- the contract cannot declare it, so the
   * migration could not make it `NOT NULL`. Nothing writes a row without one,
   * so a null here means somebody inserted by hand, and the only sane
   * response is to treat that row as absent and embed the window again.
   */
  vector: string | null;
}

async function storedChunks(chapterId: string): Promise<StoredChunk[]> {
  const plan = db.raw.sql`
    SELECT "ordinal",
           "contentHash",
           "model",
           "dimensions",
           "embedding"::text AS "vector"
      FROM "ai"."chapterChunk"
     WHERE "chapterId" = ${chapterId}
     ORDER BY "ordinal"
  `
    .returnsRow({
      ordinal: "pg/int4@1",
      contentHash: "pg/text@1",
      model: "pg/text@1",
      dimensions: "pg/int4@1",
      vector: "pg/text@1",
    })
    .build();

  return (await db.runtime().query(plan)) as StoredChunk[];
}

/**
 * Whether the stored rows are exactly what this chapter would produce now.
 *
 * Ordinal *and* hash, in order: two chapters can contain the same paragraph,
 * and a chapter can contain the same paragraph twice, so a set comparison
 * would call a reordering unchanged. The model and the width are part of the
 * comparison because vectors from two models are not comparable -- changing
 * `AI_EMBED_MODEL` has to re-embed everything, and this is where that is
 * noticed.
 */
function alreadyCurrent(
  stored: StoredChunk[],
  chunks: Chunk[],
  embedder: AiEmbedder,
): boolean {
  if (stored.length !== chunks.length) return false;

  return chunks.every((chunk, index) => {
    const row = stored[index];
    return (
      row !== undefined &&
      row.ordinal === chunk.ordinal &&
      row.contentHash === chunk.hash &&
      row.model === embedder.model &&
      row.dimensions === embedder.dimensions &&
      row.vector !== null
    );
  });
}

/* Writing ---------------------------------------------------------------- */

/** pgvector's text form. The only place a vector becomes a string. */
function toVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

/**
 * Replaces a chapter's rows with exactly these, in one transaction.
 *
 * Delete-then-insert rather than a diff, because the rows are derived data
 * with no identity worth preserving and the set is a dozen rows. The
 * transaction is what matters: a chapter is never half re-embedded, so a
 * failure leaves the previous set intact rather than a mixture of two
 * versions, which would retrieve as neither.
 */
async function replaceChunks(
  chapterId: string,
  storyId: string,
  rows: { chunk: Chunk; vector: string }[],
  embedder: AiEmbedder,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query(
      db.raw.sql`
        DELETE FROM "ai"."chapterChunk" WHERE "chapterId" = ${chapterId}
      `
        .affectedCount()
        .build(),
    );

    for (const { chunk, vector } of rows) {
      await tx.query(
        db.raw.sql`
          INSERT INTO "ai"."chapterChunk"
            ("id", "storyId", "chapterId", "ordinal", "text",
             "contentHash", "model", "dimensions", "embedding", "createdAt")
          VALUES (${randomUUID()}, ${storyId}, ${chapterId}, ${chunk.ordinal},
                  ${chunk.text}, ${chunk.hash}, ${embedder.model},
                  ${embedder.dimensions}, ${vector}::vector, now())
        `
          .affectedCount()
          .build(),
      );
    }
  });
}

/* Embedding -------------------------------------------------------------- */

/**
 * Vectors for these texts, in order, in batches.
 *
 * The width check is here rather than at the provider because this is where
 * the number that matters lives: the column is `vector(768)` and a vector of
 * any other width is not a smaller or larger answer, it is an answer to a
 * different question. Postgres would reject it too, but several statements
 * later and with a message about a type rather than about a model -- and by
 * then a backfill would have spent minutes producing vectors nothing can
 * store. Failing on the first reply is the difference between a clear error
 * and a confusing one.
 */
async function embedTexts(
  texts: string[],
  embedder: AiEmbedder,
  signal?: AbortSignal,
): Promise<{ vectors: number[][]; tokensUsed: number }> {
  const config = loadAiEmbedConfig();
  const vectors: number[][] = [];
  let tokensUsed = 0;

  for (let at = 0; at < texts.length; at += config.batchSize) {
    const batch = texts.slice(at, at + config.batchSize);
    const result = await embedder.embed({
      feature: FEATURE,
      texts: batch,
      ...(signal ? { signal } : {}),
    });

    for (const vector of result.vectors) {
      if (vector.length !== embedder.dimensions) {
        throw HttpError.upstream(
          `The embedding model returned ${vector.length} dimensions, ` +
            `but this database stores ${embedder.dimensions}. ` +
            "Check AI_EMBED_MODEL and AI_EMBED_DIMENSIONS.",
        );
      }
      vectors.push(vector);
    }

    tokensUsed += result.usage.inputTokens + result.usage.outputTokens;
  }

  return { vectors, tokensUsed };
}

/**
 * Embeds one chapter, doing as little as the stored rows allow.
 *
 * Takes the text rather than reading it, so that a caller who already has the
 * chapter in hand -- the backfill reads them in pages -- does not read it
 * twice, and so that this function has no opinion about *which* chapters are
 * worth embedding. That policy lives in the backfill script, where it can be
 * seen and changed.
 */
export async function embedChapter(
  chapter: { id: string; storyId: string; content: string },
  signal?: AbortSignal,
): Promise<ChapterEmbedding> {
  const embedder = aiEmbedder();
  const chunks = chunkChapter(chapter.content);
  const stored = await storedChunks(chapter.id);

  if (chunks.length === 0) {
    // An empty chapter with stale rows behind it: clear them rather than
    // leaving passages in the index that the chapter no longer contains.
    if (stored.length > 0) {
      await replaceChunks(chapter.id, chapter.storyId, [], embedder);
    }
    return {
      chapterId: chapter.id,
      chunks: 0,
      embedded: 0,
      reused: 0,
      unchanged: stored.length === 0,
      tokensUsed: 0,
    };
  }

  if (alreadyCurrent(stored, chunks, embedder)) {
    return {
      chapterId: chapter.id,
      chunks: chunks.length,
      embedded: 0,
      reused: chunks.length,
      unchanged: true,
      tokensUsed: 0,
    };
  }

  /**
   * Vectors worth carrying over, by the hash of the text they describe.
   *
   * Only rows written by the current model at the current width: anything else
   * is a vector in a space the new ones do not share, and mixing two spaces in
   * one index produces distances that mean nothing.
   */
  const reusable = new Map<string, string>();
  for (const row of stored) {
    if (
      row.vector !== null &&
      row.model === embedder.model &&
      row.dimensions === embedder.dimensions
    ) {
      reusable.set(row.contentHash, row.vector);
    }
  }

  const missing = chunks.filter((chunk) => !reusable.has(chunk.hash));
  const { vectors, tokensUsed } = await embedTexts(
    missing.map((chunk) => chunk.text),
    embedder,
    signal,
  );

  const fresh = new Map<string, string>();
  missing.forEach((chunk, index) => {
    fresh.set(chunk.hash, toVectorLiteral(vectors[index] as number[]));
  });

  const rows = chunks.map((chunk) => ({
    chunk,
    // `fresh` first: a hash present in both was just embedded because it was
    // not reusable, and the stale one must not win.
    vector: (fresh.get(chunk.hash) ?? reusable.get(chunk.hash)) as string,
  }));

  await replaceChunks(chapter.id, chapter.storyId, rows, embedder);

  return {
    chapterId: chapter.id,
    chunks: chunks.length,
    embedded: missing.length,
    reused: chunks.length - missing.length,
    unchanged: false,
    tokensUsed,
  };
}

/* Inspection ------------------------------------------------------------- */

/** How many windows are stored for a chapter. For tests and the backfill. */
export async function countChunks(chapterId: string): Promise<number> {
  return (
    await db.orm.ai.ChapterChunk.select("id")
      .where((row) => row.chapterId.eq(chapterId))
      .all()
  ).length;
}

/** Removes a chapter's rows. Used by tests; production relies on the cascade. */
export async function deleteChunks(chapterId: string): Promise<void> {
  const plan = db.raw.sql`
    DELETE FROM "ai"."chapterChunk" WHERE "chapterId" = ${chapterId}
  `
    .affectedCount()
    .build();

  await db.runtime().query(plan);
}
