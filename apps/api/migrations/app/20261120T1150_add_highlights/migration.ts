#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/32647ea05528d39d6b360a7d0102ad631434e9b7f17877c5c4c378c273b1b5da/contract';
import endContract from '../../snapshots/32647ea05528d39d6b360a7d0102ad631434e9b7f17877c5c4c378c273b1b5da/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/67a9ce00722e0466a1ae2aeb83d8477e70000921add3526342f7117f9f747494/contract';
import startContract from '../../snapshots/67a9ce00722e0466a1ae2aeb83d8477e70000921add3526342f7117f9f747494/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'engagement',
        table: 'highlight',
        columns: [
          col('chapterId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('end', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('note', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('quote', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('start', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('storyId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createIndex({
        schema: 'engagement',
        table: 'highlight',
        index: 'highlight_chapterId_idx_411dd3d6',
        columns: ['chapterId'],
      }),
      this.createIndex({
        schema: 'engagement',
        table: 'highlight',
        index: 'highlight_storyId_idx_cd452158',
        columns: ['storyId'],
      }),
      this.createIndex({
        schema: 'engagement',
        table: 'highlight',
        index: 'highlight_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.createIndex({
        schema: 'engagement',
        table: 'highlight',
        index: 'highlight_userId_storyId_idx_57dae79f',
        columns: ['userId', 'storyId'],
      }),
      this.addForeignKey({
        schema: 'engagement',
        table: 'highlight',
        foreignKey: {
          name: 'highlight_userId_fkey',
          columns: ['userId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'engagement',
        table: 'highlight',
        foreignKey: {
          name: 'highlight_storyId_fkey',
          columns: ['storyId'],
          references: { schema: 'content', table: 'story', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'engagement',
        table: 'highlight',
        foreignKey: {
          name: 'highlight_chapterId_fkey',
          columns: ['chapterId'],
          references: { schema: 'content', table: 'chapter', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
