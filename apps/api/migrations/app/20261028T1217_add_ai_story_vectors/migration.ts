#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/5654ec2c5bf2c32761d6123bfc98d2e336984295d3738b44b739bf753169c25f/contract';
import startContract from '../../snapshots/5654ec2c5bf2c32761d6123bfc98d2e336984295d3738b44b739bf753169c25f/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/c4c461506692484099836f39eaf626650fd2b2da0d5681cb0367cdd730447bb4/contract';
import endContract from '../../snapshots/c4c461506692484099836f39eaf626650fd2b2da0d5681cb0367cdd730447bb4/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, primaryKey, rawSql } from '@prisma/orm-postgres/migration';

/**
 * One vector per story, for the recommender (`ai.StoryVector`).
 *
 * - **`ADD COLUMN embedding vector(768)`**, by raw SQL, for the reason
 *   `20260925T1018_add_ai_chapter_chunks` gives: the contract cannot declare a
 *   pgvector column yet, so the column is the migration's and every read and
 *   write of it is `services/ai/embeddings.ts`'s. The width is that
 *   migration's, which is the width of the passages being averaged.
 * - **The backfill**, so a database with passages has its story vectors the
 *   moment this lands rather than after somebody remembers to run a script;
 *   until then every story would score zero on `similar`. It averages exactly
 *   what `refreshStoryVector` averages -- published chapters, one model and
 *   width -- and where a story has passages from more than one model (a
 *   re-embedding half done), takes the model with the most, which is the one
 *   being moved to or the one not yet left.
 */

/** Matches `AI_EMBED_DIMENSIONS` and the `chapterChunk` column. */
const EMBEDDING_DIMENSIONS = 768;

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'ai',
        table: 'storyVector',
        columns: [
          col('dimensions', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('model', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('passages', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('storyId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [primaryKey(['storyId'])],
      }),
      rawSql({
        id: 'column.storyVector.embedding',
        label: 'Add column "embedding" vector(768) to "storyVector"',
        operationClass: 'additive',
        target: { id: 'postgres' },
        precheck: [],
        execute: [
          {
            description: 'Add column "embedding" to "ai"."storyVector"',
            sql:
              'ALTER TABLE "ai"."storyVector" ' +
              `ADD COLUMN "embedding" vector(${EMBEDDING_DIMENSIONS}) NOT NULL`,
          },
        ],
        postcheck: [],
      }),
      this.addForeignKey({
        schema: 'ai',
        table: 'storyVector',
        foreignKey: {
          name: 'storyVector_storyId_fkey',
          columns: ['storyId'],
          references: { schema: 'content', table: 'story', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      rawSql({
        id: 'data.ai.storyVector.backfill',
        label: 'Average each story\'s published passages into ai.storyVector',
        operationClass: 'data',
        target: {
          id: 'ai.storyVector',
          details: { schema: 'ai', name: 'storyVector', objectType: 'table' },
        },
        precheck: [],
        execute: [
          {
            description: 'One averaged vector per story, from its published passages',
            sql: `INSERT INTO "ai"."storyVector"
                    ("storyId", "model", "dimensions", "passages", "embedding")
                  SELECT DISTINCT ON (pc."storyId")
                         pc."storyId", pc."model", pc."dimensions",
                         COUNT(*)::int, AVG(pc."embedding")
                    FROM "ai"."chapterChunk" AS pc
                    JOIN "content"."chapter" AS ch ON ch."id" = pc."chapterId"
                   WHERE pc."embedding" IS NOT NULL
                     AND ch."publishedAt" IS NOT NULL
                   GROUP BY pc."storyId", pc."model", pc."dimensions"
                   ORDER BY pc."storyId", COUNT(*) DESC, pc."model"`,
          },
        ],
        postcheck: [],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
