/**
 * Embeds every chapter that is not embedded yet.
 *
 *   pnpm --filter api seed:embeddings          # published chapters only
 *   pnpm --filter api seed:embeddings --all    # drafts and unlisted too
 *
 * Mirrors `seed:stories` in being **safe to re-run**, and does rather more
 * than that phrase usually means: `embedChapter` compares what is stored
 * against what the chapter would produce now, so a second run over an
 * unchanged corpus makes no model calls and writes no rows. That is the normal
 * case -- this is the command you run after adding a story, and almost
 * everything it looks at is already done.
 *
 * It is also the only thing in the repo that fills the embedding table. There
 * is no job runner (Task AI 20) and nothing embeds on publish: a chapter
 * written today is retrievable once somebody runs this.
 *
 * **Drafts are skipped unless `--all` is passed.** A vector index does not
 * know that a story is unlisted or a chapter unpublished -- that rule lives in
 * `visibleTo` in `services/stories.ts`, and `services/ai/search.ts` applies
 * it to every result. Keeping unpublished writing out of the index as well is
 * the second line of that defence, not the first. `--all` is there for working
 * on search, not for a deployment.
 *
 * It also builds the search index; see `ensureEmbeddingIndex` for why that is
 * here rather than in a migration.
 */

import { db } from "../prisma/db.js";
import {
  embedChapter,
  ensureEmbeddingIndex,
} from "../services/ai/embeddings.js";
import { loadAiEmbedConfig } from "../services/ai/config.js";

interface ChapterRow {
  id: string;
  storyId: string;
  content: string;
  chapterNumber: number;
  storyTitle: string;
}

/**
 * Two statements rather than one with an interpolated predicate: every `${}`
 * in `db.raw.sql` is a bound parameter and never a fragment of SQL, which is
 * the same reason `services/engagement.ts` spells its two tables out.
 */
function chaptersQuery(includeDrafts: boolean) {
  const columns = {
    id: "pg/text@1",
    storyId: "pg/text@1",
    content: "pg/text@1",
    chapterNumber: "pg/int4@1",
    storyTitle: "pg/text@1",
  } as const;

  return includeDrafts
    ? db.raw.sql`
        SELECT ch."id",
               ch."storyId",
               ch."content",
               ch."chapterNumber",
               s."title" AS "storyTitle"
          FROM "content"."chapter" AS ch
          JOIN "content"."story" AS s ON s."id" = ch."storyId"
         ORDER BY s."title", ch."chapterNumber"
      `
        .returnsRow(columns)
        .build()
    : db.raw.sql`
        SELECT ch."id",
               ch."storyId",
               ch."content",
               ch."chapterNumber",
               s."title" AS "storyTitle"
          FROM "content"."chapter" AS ch
          JOIN "content"."story" AS s ON s."id" = ch."storyId"
         WHERE ch."publishedAt" IS NOT NULL
           AND s."listedAt" IS NOT NULL
         ORDER BY s."title", ch."chapterNumber"
      `
        .returnsRow(columns)
        .build();
}

async function main(): Promise<void> {
  const includeDrafts = process.argv.includes("--all");
  const config = loadAiEmbedConfig();

  console.log(
    `Embedding with ${config.model} (${config.dimensions}d) ` +
      `via ${config.provider} at ${config.baseUrl}` +
      (includeDrafts ? "\nIncluding drafts and unlisted stories." : ""),
  );

  const chapters = (await db
    .runtime()
    .query(chaptersQuery(includeDrafts))) as ChapterRow[];

  let embedded = 0;
  let reused = 0;
  let unchanged = 0;
  let tokens = 0;

  for (const chapter of chapters) {
    const result = await embedChapter(chapter);

    embedded += result.embedded;
    reused += result.reused;
    tokens += result.tokensUsed;
    if (result.unchanged) {
      unchanged += 1;
      continue;
    }

    console.log(
      `  ${chapter.storyTitle} ch.${chapter.chapterNumber}: ` +
        `${result.chunks} chunks (${result.embedded} embedded, ${result.reused} reused)`,
    );
  }

  console.log(
    `\n${chapters.length} chapters, ${unchanged} already current.\n` +
      `${embedded} chunks embedded, ${reused} reused, ${tokens} tokens.`,
  );

  // After the rows, not before: an HNSW index is built incrementally either
  // way, but building it over a full table is one pass rather than one graph
  // insertion per row. A no-op on every run after the first.
  await ensureEmbeddingIndex();
  console.log("Search index (HNSW, cosine) is in place.");
}

await main();
await db.close();
