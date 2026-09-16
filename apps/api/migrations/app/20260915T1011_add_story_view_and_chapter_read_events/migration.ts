#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/6d8f8e7f0f0212ed12a8a583909d0caed0665164e47f82d41cac62030afaf0a8/contract';
import endContract from '../../snapshots/6d8f8e7f0f0212ed12a8a583909d0caed0665164e47f82d41cac62030afaf0a8/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/efd4d8e5f424a80aab08e125ffc91d1c0f204592b83ceb11c95cf4736a5f58f2/contract';
import startContract from '../../snapshots/efd4d8e5f424a80aab08e125ffc91d1c0f204592b83ceb11c95cf4736a5f58f2/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'engagement',
        table: 'chapterRead',
        columns: [
          col('chapterId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('day', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('storyId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('userId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('visitorKey', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'engagement',
        table: 'storyView',
        columns: [
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('day', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('storyId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('userId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('visitorKey', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addUnique({
        schema: 'engagement',
        table: 'chapterRead',
        constraint: 'chapterRead_chapterId_visitorKey_day_key',
        columns: ['chapterId', 'visitorKey', 'day'],
      }),
      this.addUnique({
        schema: 'engagement',
        table: 'storyView',
        constraint: 'storyView_storyId_visitorKey_day_key',
        columns: ['storyId', 'visitorKey', 'day'],
      }),
      this.createIndex({
        schema: 'engagement',
        table: 'chapterRead',
        index: 'chapterRead_chapterId_day_idx_d49704f1',
        columns: ['chapterId', 'day'],
      }),
      this.createIndex({
        schema: 'engagement',
        table: 'chapterRead',
        index: 'chapterRead_chapterId_idx_411dd3d6',
        columns: ['chapterId'],
      }),
      this.createIndex({
        schema: 'engagement',
        table: 'chapterRead',
        index: 'chapterRead_storyId_day_idx_00c4c762',
        columns: ['storyId', 'day'],
      }),
      this.createIndex({
        schema: 'engagement',
        table: 'chapterRead',
        index: 'chapterRead_storyId_idx_cd452158',
        columns: ['storyId'],
      }),
      this.createIndex({
        schema: 'engagement',
        table: 'chapterRead',
        index: 'chapterRead_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.createIndex({
        schema: 'engagement',
        table: 'storyView',
        index: 'storyView_storyId_day_idx_00c4c762',
        columns: ['storyId', 'day'],
      }),
      this.createIndex({
        schema: 'engagement',
        table: 'storyView',
        index: 'storyView_storyId_idx_cd452158',
        columns: ['storyId'],
      }),
      this.createIndex({
        schema: 'engagement',
        table: 'storyView',
        index: 'storyView_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.addForeignKey({
        schema: 'engagement',
        table: 'chapterRead',
        foreignKey: {
          name: 'chapterRead_storyId_fkey',
          columns: ['storyId'],
          references: { schema: 'content', table: 'story', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'engagement',
        table: 'chapterRead',
        foreignKey: {
          name: 'chapterRead_chapterId_fkey',
          columns: ['chapterId'],
          references: { schema: 'content', table: 'chapter', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'engagement',
        table: 'chapterRead',
        foreignKey: {
          name: 'chapterRead_userId_fkey',
          columns: ['userId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'engagement',
        table: 'storyView',
        foreignKey: {
          name: 'storyView_storyId_fkey',
          columns: ['storyId'],
          references: { schema: 'content', table: 'story', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'engagement',
        table: 'storyView',
        foreignKey: {
          name: 'storyView_userId_fkey',
          columns: ['userId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
