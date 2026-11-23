#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/32647ea05528d39d6b360a7d0102ad631434e9b7f17877c5c4c378c273b1b5da/contract';
import startContract from '../../snapshots/32647ea05528d39d6b360a7d0102ad631434e9b7f17877c5c4c378c273b1b5da/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/3ad9268a9017de126b9cf31583c92e8d3f02d321e4afba3e1419b5b5e2b8cfe4/contract';
import endContract from '../../snapshots/3ad9268a9017de126b9cf31583c92e8d3f02d321e4afba3e1419b5b5e2b8cfe4/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createSchema({ schema: 'beta' }),
      this.dropCheckConstraint({
        schema: 'auth',
        table: 'notificationMute',
        constraint: 'notificationMute_type_check_fd2b9b0f',
      }),
      this.dropCheckConstraint({
        schema: 'notifications',
        table: 'notification',
        constraint: 'notification_type_check_fd2b9b0f',
      }),
      this.createTable({
        schema: 'beta',
        table: 'feedback',
        columns: [
          col('body', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('chapterId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('quote', 'text', { codecRef: { codecId: 'pg/text@1' } }),
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
      this.createTable({
        schema: 'beta',
        table: 'link',
        columns: [
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('storyId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('token', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['storyId'])],
      }),
      this.createTable({
        schema: 'beta',
        table: 'reader',
        columns: [
          col('joinedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('storyId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['storyId', 'userId'])],
      }),
      this.addCheckConstraint({
        schema: 'auth',
        table: 'notificationMute',
        constraint: 'notificationMute_type_check_8fc7182a',
        expression:
          "\"type\" IN ('CHANNEL_POST', 'COMMENT_REPLY', 'STORY_COMMENT', 'CLUB_DISCUSSION', 'NEW_STORY', 'NEW_CHAPTER', 'BADGE_EARNED', 'LEVEL_UP', 'CONTENT_HIDDEN', 'REPORT_RESOLVED', 'BETA_FEEDBACK')",
      }),
      this.addUnique({
        schema: 'beta',
        table: 'link',
        constraint: 'link_token_key',
        columns: ['token'],
      }),
      this.addCheckConstraint({
        schema: 'notifications',
        table: 'notification',
        constraint: 'notification_type_check_8fc7182a',
        expression:
          "\"type\" IN ('CHANNEL_POST', 'COMMENT_REPLY', 'STORY_COMMENT', 'CLUB_DISCUSSION', 'NEW_STORY', 'NEW_CHAPTER', 'BADGE_EARNED', 'LEVEL_UP', 'CONTENT_HIDDEN', 'REPORT_RESOLVED', 'BETA_FEEDBACK')",
      }),
      this.createIndex({
        schema: 'beta',
        table: 'feedback',
        index: 'feedback_chapterId_idx_411dd3d6',
        columns: ['chapterId'],
      }),
      this.createIndex({
        schema: 'beta',
        table: 'feedback',
        index: 'feedback_storyId_createdAt_idx_90880359',
        columns: ['storyId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'beta',
        table: 'feedback',
        index: 'feedback_storyId_idx_cd452158',
        columns: ['storyId'],
      }),
      this.createIndex({
        schema: 'beta',
        table: 'feedback',
        index: 'feedback_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.createIndex({
        schema: 'beta',
        table: 'feedback',
        index: 'feedback_userId_storyId_idx_57dae79f',
        columns: ['userId', 'storyId'],
      }),
      this.createIndex({
        schema: 'beta',
        table: 'reader',
        index: 'reader_storyId_idx_cd452158',
        columns: ['storyId'],
      }),
      this.createIndex({
        schema: 'beta',
        table: 'reader',
        index: 'reader_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.addForeignKey({
        schema: 'beta',
        table: 'feedback',
        foreignKey: {
          name: 'feedback_storyId_fkey',
          columns: ['storyId'],
          references: { schema: 'content', table: 'story', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'beta',
        table: 'feedback',
        foreignKey: {
          name: 'feedback_chapterId_fkey',
          columns: ['chapterId'],
          references: { schema: 'content', table: 'chapter', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'beta',
        table: 'feedback',
        foreignKey: {
          name: 'feedback_userId_fkey',
          columns: ['userId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'beta',
        table: 'link',
        foreignKey: {
          name: 'link_storyId_fkey',
          columns: ['storyId'],
          references: { schema: 'content', table: 'story', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'beta',
        table: 'reader',
        foreignKey: {
          name: 'reader_storyId_fkey',
          columns: ['storyId'],
          references: { schema: 'content', table: 'story', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'beta',
        table: 'reader',
        foreignKey: {
          name: 'reader_userId_fkey',
          columns: ['userId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
