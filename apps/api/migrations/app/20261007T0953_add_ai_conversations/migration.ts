#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/2e2d925a6f69cc5591018756d801b51e12b9ad2040b4f99951a8634370365d3f/contract';
import startContract from '../../snapshots/2e2d925a6f69cc5591018756d801b51e12b9ad2040b4f99951a8634370365d3f/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/639fea0256b9f96efffea05a925f290f0f5bd3b6c913360494701bd16bff675c/contract';
import endContract from '../../snapshots/639fea0256b9f96efffea05a925f290f0f5bd3b6c913360494701bd16bff675c/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, lit, primaryKey } from '@prisma/orm-postgres/migration';

/**
 * Ask This Book conversations: the conversation, its turns, and the passages
 * each answer cited.
 *
 * Entirely additive -- three new tables in the existing `ai` schema -- so
 * there is no backfill: nobody has a conversation until they start one.
 *
 * Every foreign key cascades. A conversation is worthless once its reader or
 * its story is gone, and the reader's questions are personal data an account
 * deletion must take with it; the cascade means neither `deleteAccount` nor
 * `deleteStory` has to know these tables exist. A citation cascades from its
 * chapter for the same reason, leaving the answer's text and dropping only
 * the link.
 *
 * The two unique constraints are load-bearing: `(conversationId, ordinal)` is
 * what makes a double-submitted question collide instead of interleaving, and
 * `(messageId, marker)` keeps one citation per `[n]`.
 */
export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'ai',
        table: 'conversation',
        columns: [
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('storyId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('summarizedThrough', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('summary', 'text', {
            notNull: true,
            default: lit(''),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('title', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
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
        schema: 'ai',
        table: 'conversationCitation',
        columns: [
          col('chapterId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('marker', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('messageId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('ordinal', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('quote', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'ai',
        table: 'conversationMessage',
        columns: [
          col('answerable', 'bool', {
            notNull: true,
            default: lit(true),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('content', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('conversationId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('inputTokens', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('ordinal', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('outputTokens', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('role', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('scopeBasis', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('standaloneQuestion', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('upToChapter', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addUnique({
        schema: 'ai',
        table: 'conversationCitation',
        constraint: 'conversationCitation_messageId_marker_key',
        columns: ['messageId', 'marker'],
      }),
      this.addUnique({
        schema: 'ai',
        table: 'conversationMessage',
        constraint: 'conversationMessage_conversationId_ordinal_key',
        columns: ['conversationId', 'ordinal'],
      }),
      this.createIndex({
        schema: 'ai',
        table: 'conversation',
        index: 'conversation_storyId_idx_cd452158',
        columns: ['storyId'],
      }),
      this.createIndex({
        schema: 'ai',
        table: 'conversation',
        index: 'conversation_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.createIndex({
        schema: 'ai',
        table: 'conversation',
        index: 'conversation_userId_storyId_idx_57dae79f',
        columns: ['userId', 'storyId'],
      }),
      this.createIndex({
        schema: 'ai',
        table: 'conversationCitation',
        index: 'conversationCitation_chapterId_idx_411dd3d6',
        columns: ['chapterId'],
      }),
      this.createIndex({
        schema: 'ai',
        table: 'conversationCitation',
        index: 'conversationCitation_messageId_idx_3cdded8d',
        columns: ['messageId'],
      }),
      this.createIndex({
        schema: 'ai',
        table: 'conversationMessage',
        index: 'conversationMessage_conversationId_idx_669215a6',
        columns: ['conversationId'],
      }),
      this.addForeignKey({
        schema: 'ai',
        table: 'conversation',
        foreignKey: {
          name: 'conversation_userId_fkey',
          columns: ['userId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'ai',
        table: 'conversation',
        foreignKey: {
          name: 'conversation_storyId_fkey',
          columns: ['storyId'],
          references: { schema: 'content', table: 'story', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'ai',
        table: 'conversationCitation',
        foreignKey: {
          name: 'conversationCitation_messageId_fkey',
          columns: ['messageId'],
          references: { schema: 'ai', table: 'conversationMessage', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'ai',
        table: 'conversationCitation',
        foreignKey: {
          name: 'conversationCitation_chapterId_fkey',
          columns: ['chapterId'],
          references: { schema: 'content', table: 'chapter', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'ai',
        table: 'conversationMessage',
        foreignKey: {
          name: 'conversationMessage_conversationId_fkey',
          columns: ['conversationId'],
          references: { schema: 'ai', table: 'conversation', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
