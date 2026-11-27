#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/4e78549436ca508aadd25c219590f1319eb21efef8b109ce2a8dcf696ab8fc73/contract';
import endContract from '../../snapshots/4e78549436ca508aadd25c219590f1319eb21efef8b109ce2a8dcf696ab8fc73/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/b720b6732b227b2bfa239bdf5cfe49a6a9e3a8e0e5db3f47994dfe9c16f07d18/contract';
import startContract from '../../snapshots/b720b6732b227b2bfa239bdf5cfe49a6a9e3a8e0e5db3f47994dfe9c16f07d18/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, lit, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createSchema({ schema: 'lists' }),
      this.dropCheckConstraint({
        schema: 'ai',
        table: 'moderationDecision',
        constraint: 'moderationDecision_targetType_check_4fe6a63e',
      }),
      this.dropCheckConstraint({
        schema: 'auth',
        table: 'notificationMute',
        constraint: 'notificationMute_type_check_8fc7182a',
      }),
      this.dropCheckConstraint({
        schema: 'moderation',
        table: 'report',
        constraint: 'report_targetType_check_4fe6a63e',
      }),
      this.dropCheckConstraint({
        schema: 'notifications',
        table: 'notification',
        constraint: 'notification_sourceType_check_f9b36c93',
      }),
      this.dropCheckConstraint({
        schema: 'notifications',
        table: 'notification',
        constraint: 'notification_type_check_8fc7182a',
      }),
      this.createTable({
        schema: 'lists',
        table: 'listEntry',
        columns: [
          col('addedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('listId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('note', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('storyId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'lists',
        table: 'listFollower',
        columns: [
          col('followedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('listId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['listId', 'userId'])],
      }),
      this.createTable({
        schema: 'lists',
        table: 'readingList',
        columns: [
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('description', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('hiddenAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('isPublic', 'bool', {
            notNull: true,
            default: lit(true),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('slug', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addCheckConstraint({
        schema: 'ai',
        table: 'moderationDecision',
        constraint: 'moderationDecision_targetType_check_9328c492',
        expression:
          "\"targetType\" IN ('COMMENT', 'CLUB_DISCUSSION', 'CHANNEL_POST', 'STORY', 'CHAPTER', 'PROFILE', 'CLUB', 'CHANNEL', 'READING_LIST')",
      }),
      this.addCheckConstraint({
        schema: 'auth',
        table: 'notificationMute',
        constraint: 'notificationMute_type_check_95c8c07c',
        expression:
          "\"type\" IN ('CHANNEL_POST', 'COMMENT_REPLY', 'STORY_COMMENT', 'CLUB_DISCUSSION', 'NEW_STORY', 'NEW_CHAPTER', 'BADGE_EARNED', 'LEVEL_UP', 'CONTENT_HIDDEN', 'REPORT_RESOLVED', 'BETA_FEEDBACK', 'LIST_ADDITION')",
      }),
      this.addUnique({
        schema: 'lists',
        table: 'listEntry',
        constraint: 'listEntry_listId_storyId_key',
        columns: ['listId', 'storyId'],
      }),
      this.addUnique({
        schema: 'lists',
        table: 'readingList',
        constraint: 'readingList_slug_key',
        columns: ['slug'],
      }),
      this.addCheckConstraint({
        schema: 'moderation',
        table: 'report',
        constraint: 'report_targetType_check_9328c492',
        expression:
          "\"targetType\" IN ('COMMENT', 'CLUB_DISCUSSION', 'CHANNEL_POST', 'STORY', 'CHAPTER', 'PROFILE', 'CLUB', 'CHANNEL', 'READING_LIST')",
      }),
      this.addCheckConstraint({
        schema: 'notifications',
        table: 'notification',
        constraint: 'notification_sourceType_check_84454683',
        expression:
          "\"sourceType\" IN ('COMMENT', 'CLUB_DISCUSSION', 'CHANNEL_POST', 'STORY', 'CHAPTER', 'PROFILE', 'CLUB', 'CHANNEL', 'READING_LIST')",
      }),
      this.addCheckConstraint({
        schema: 'notifications',
        table: 'notification',
        constraint: 'notification_type_check_95c8c07c',
        expression:
          "\"type\" IN ('CHANNEL_POST', 'COMMENT_REPLY', 'STORY_COMMENT', 'CLUB_DISCUSSION', 'NEW_STORY', 'NEW_CHAPTER', 'BADGE_EARNED', 'LEVEL_UP', 'CONTENT_HIDDEN', 'REPORT_RESOLVED', 'BETA_FEEDBACK', 'LIST_ADDITION')",
      }),
      this.createIndex({
        schema: 'lists',
        table: 'listEntry',
        index: 'listEntry_listId_addedAt_idx_959c2581',
        columns: ['listId', 'addedAt'],
      }),
      this.createIndex({
        schema: 'lists',
        table: 'listEntry',
        index: 'listEntry_listId_idx_0033d367',
        columns: ['listId'],
      }),
      this.createIndex({
        schema: 'lists',
        table: 'listEntry',
        index: 'listEntry_storyId_idx_cd452158',
        columns: ['storyId'],
      }),
      this.createIndex({
        schema: 'lists',
        table: 'listFollower',
        index: 'listFollower_listId_idx_0033d367',
        columns: ['listId'],
      }),
      this.createIndex({
        schema: 'lists',
        table: 'listFollower',
        index: 'listFollower_userId_followedAt_idx_c7eecc26',
        columns: ['userId', 'followedAt'],
      }),
      this.createIndex({
        schema: 'lists',
        table: 'listFollower',
        index: 'listFollower_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.createIndex({
        schema: 'lists',
        table: 'readingList',
        index: 'readingList_userId_createdAt_idx_f726f04a',
        columns: ['userId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'lists',
        table: 'readingList',
        index: 'readingList_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.addForeignKey({
        schema: 'lists',
        table: 'listEntry',
        foreignKey: {
          name: 'listEntry_listId_fkey',
          columns: ['listId'],
          references: { schema: 'lists', table: 'readingList', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'lists',
        table: 'listEntry',
        foreignKey: {
          name: 'listEntry_storyId_fkey',
          columns: ['storyId'],
          references: { schema: 'content', table: 'story', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'lists',
        table: 'listFollower',
        foreignKey: {
          name: 'listFollower_listId_fkey',
          columns: ['listId'],
          references: { schema: 'lists', table: 'readingList', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'lists',
        table: 'listFollower',
        foreignKey: {
          name: 'listFollower_userId_fkey',
          columns: ['userId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'lists',
        table: 'readingList',
        foreignKey: {
          name: 'readingList_userId_fkey',
          columns: ['userId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
