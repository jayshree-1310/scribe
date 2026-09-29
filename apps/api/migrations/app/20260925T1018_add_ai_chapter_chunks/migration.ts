#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/2e2d925a6f69cc5591018756d801b51e12b9ad2040b4f99951a8634370365d3f/contract';
import endContract from '../../snapshots/2e2d925a6f69cc5591018756d801b51e12b9ad2040b4f99951a8634370365d3f/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/d6fc7e415642368b7f80b2c9510bd90d28c385360fbde9a7bf7962f0dd15981c/contract';
import startContract from '../../snapshots/d6fc7e415642368b7f80b2c9510bd90d28c385360fbde9a7bf7962f0dd15981c/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  col,
  createExtension,
  fn,
  primaryKey,
  rawSql,
} from '@prisma/orm-postgres/migration';

/** Matches `AI_EMBED_DIMENSIONS` and `nomic-embed-text`; see `config.ts`. */
const EMBEDDING_DIMENSIONS = 768;

/**
 * `ai.chapterChunk`: the embedded passages retrieval runs over.
 *
 * Additive throughout -- a new table, three indexes, two cascading foreign
 * keys -- so there is no backfill here and nothing to decide about existing
 * rows. Filling the table is `pnpm --filter api seed:embeddings`, which is
 * re-runnable and does nothing for content that is already embedded.
 *
 * Two operations the planner did not write, because the contract cannot
 * express them:
 *
 * - **`CREATE EXTENSION vector`.** `pg_trgm` ships with Postgres; `vector`
 *   does not. `docker-compose.yml` now runs `pgvector/pgvector:pg17` so the
 *   extension is installed in the image and this can enable it. An existing
 *   development volume needs nothing beyond recreating that container -- the
 *   data is untouched -- but a database on an image without pgvector will fail
 *   here, loudly, which is the correct place to find out.
 *
 * - **`ADD COLUMN embedding vector(768)`.** The Prisma Next pgvector extension
 *   package that would let `contract.prisma` declare this column is not
 *   published for this release, so the column is added here with explicit SQL
 *   and read and written through the raw-SQL lane in
 *   `services/ai/embeddings.ts`. The contract therefore describes every column
 *   of this table except the vector. Plain `db verify` accepts that -- extras
 *   in the database are allowed -- while `db verify --strict` will name it.
 *
 * The column is nullable because the type system cannot make it otherwise
 * here, not because a row without a vector is meaningful. Nothing writes one:
 * `embeddings.ts` inserts the text and the vector in the same statement, so a
 * chunk row and its embedding arrive together or not at all.
 *
 * 768 is `nomic-embed-text`'s width, and it is written into the column type,
 * which is the point of the constant above: changing the embedding model to
 * one of a different width is this migration again plus a re-embedding of the
 * whole corpus, not an environment variable.
 */
export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      // Before the table: the column below has no type without it.
      createExtension('vector'),
      this.createTable({
        schema: 'ai',
        table: 'chapterChunk',
        columns: [
          col('chapterId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('contentHash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('dimensions', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('model', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('ordinal', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('storyId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('text', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      rawSql({
        id: 'column.chapterChunk.embedding',
        label: 'Add column "embedding" vector(768) to "chapterChunk"',
        operationClass: 'additive',
        target: { id: 'postgres' },
        precheck: [],
        execute: [
          {
            description: 'Add column "embedding" to "ai"."chapterChunk"',
            sql:
              'ALTER TABLE "ai"."chapterChunk" ' +
              `ADD COLUMN "embedding" vector(${EMBEDDING_DIMENSIONS})`,
          },
        ],
        postcheck: [],
      }),
      this.addUnique({
        schema: 'ai',
        table: 'chapterChunk',
        constraint: 'chapterChunk_chapterId_ordinal_key',
        columns: ['chapterId', 'ordinal'],
      }),
      this.createIndex({
        schema: 'ai',
        table: 'chapterChunk',
        index: 'chapterChunk_chapterId_contentHash_idx_b343f6d1',
        columns: ['chapterId', 'contentHash'],
      }),
      this.createIndex({
        schema: 'ai',
        table: 'chapterChunk',
        index: 'chapterChunk_chapterId_idx_411dd3d6',
        columns: ['chapterId'],
      }),
      this.createIndex({
        schema: 'ai',
        table: 'chapterChunk',
        index: 'chapterChunk_storyId_idx_cd452158',
        columns: ['storyId'],
      }),
      this.addForeignKey({
        schema: 'ai',
        table: 'chapterChunk',
        foreignKey: {
          name: 'chapterChunk_storyId_fkey',
          columns: ['storyId'],
          references: { schema: 'content', table: 'story', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'ai',
        table: 'chapterChunk',
        foreignKey: {
          name: 'chapterChunk_chapterId_fkey',
          columns: ['chapterId'],
          references: { schema: 'content', table: 'chapter', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
