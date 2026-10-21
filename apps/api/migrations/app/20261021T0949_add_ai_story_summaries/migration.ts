#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/5654ec2c5bf2c32761d6123bfc98d2e336984295d3738b44b739bf753169c25f/contract';
import endContract from '../../snapshots/5654ec2c5bf2c32761d6123bfc98d2e336984295d3738b44b739bf753169c25f/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/b14ab879de7df6f1227004c5b4312618a4ab9132ffab232da3fd955fbb3251c2/contract';
import startContract from '../../snapshots/b14ab879de7df6f1227004c5b4312618a4ab9132ffab232da3fd955fbb3251c2/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, lit, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'ai',
        table: 'storySummary',
        columns: [
          col('chapterCount', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('model', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('promptId', 'text', {
            notNull: true,
            default: lit('summary.story'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('promptVersion', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('sourceHash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('storyId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('text', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('upToChapter', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
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
        table: 'storySummary',
        constraint: 'storySummary_storyId_upToChapter_key',
        columns: ['storyId', 'upToChapter'],
      }),
      this.createIndex({
        schema: 'ai',
        table: 'storySummary',
        index: 'storySummary_storyId_idx_cd452158',
        columns: ['storyId'],
      }),
      this.addForeignKey({
        schema: 'ai',
        table: 'storySummary',
        foreignKey: {
          name: 'storySummary_storyId_fkey',
          columns: ['storyId'],
          references: { schema: 'content', table: 'story', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
