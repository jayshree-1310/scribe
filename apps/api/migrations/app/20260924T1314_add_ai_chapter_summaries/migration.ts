#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/d6fc7e415642368b7f80b2c9510bd90d28c385360fbde9a7bf7962f0dd15981c/contract';
import endContract from '../../snapshots/d6fc7e415642368b7f80b2c9510bd90d28c385360fbde9a7bf7962f0dd15981c/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/e89d7b557c0039c370910c43fa29a533e5c244fdf78e295611d70ee1189c46a3/contract';
import startContract from '../../snapshots/e89d7b557c0039c370910c43fa29a533e5c244fdf78e295611d70ee1189c46a3/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, primaryKey } from '@prisma/orm-postgres/migration';

/**
 * The `ai` namespace, and the first thing stored in it: chapter recaps.
 *
 * Entirely additive -- a new schema, one table, one unique constraint and one
 * foreign key -- so there is no backfill and nothing to decide about existing
 * rows. A chapter nobody has asked for a recap of has no row, which is the
 * correct state rather than a gap: these are generated lazily, by the first
 * reader who asks to be caught up.
 *
 * The unique constraint on `chapterId` is load-bearing rather than tidy. It is
 * what makes "write the recap for this chapter" an upsert the service can run
 * without reading first, and it is what stops two readers who arrive at the
 * same cold chapter from leaving two rows nothing could choose between.
 *
 * Deleting a chapter is not handled here and does not need to be: the foreign
 * key means a chapter cannot be deleted out from under its summary, and the
 * authoring service deletes the summary with it.
 */
export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createSchema({ schema: 'ai' }),
      this.createTable({
        schema: 'ai',
        table: 'chapterSummary',
        columns: [
          col('chapterId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('contentHash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('model', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('promptVersion', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('text', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addUnique({
        schema: 'ai',
        table: 'chapterSummary',
        constraint: 'chapterSummary_chapterId_key',
        columns: ['chapterId'],
      }),
      this.addForeignKey({
        schema: 'ai',
        table: 'chapterSummary',
        foreignKey: {
          name: 'chapterSummary_chapterId_fkey',
          columns: ['chapterId'],
          references: { schema: 'content', table: 'chapter', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
