#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/0c167f3d32cb8e11103360cae4c1ec9ed7bbdaf214fef734a0c4c5e27363b96f/contract';
import endContract from '../../snapshots/0c167f3d32cb8e11103360cae4c1ec9ed7bbdaf214fef734a0c4c5e27363b96f/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/639fea0256b9f96efffea05a925f290f0f5bd3b6c913360494701bd16bff675c/contract';
import startContract from '../../snapshots/639fea0256b9f96efffea05a925f290f0f5bd3b6c913360494701bd16bff675c/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  col,
  fn,
  lit,
  primaryKey,
  rawSql,
} from '@prisma/orm-postgres/migration';

/** Matches `ai.chapterChunk.embedding` and `AI_EMBED_DIMENSIONS`; see `config.ts`. */
const EMBEDDING_DIMENSIONS = 768;

/**
 * The story bible (Task AI 13) and the continuity checker (Task AI 14).
 *
 * Additive throughout -- five new tables in the existing `ai` schema -- so
 * there is no backfill: a story has no bible until its author builds one.
 *
 * One operation the planner did not write, for the reason the chunk migration
 * gives: `storyFact.embedding vector(768)`. The contract cannot declare a
 * pgvector column in this release, so it is added here with explicit SQL and
 * read and written through the raw-SQL lane in
 * `services/ai/story-bible.ts`. It is nullable on purpose this time, not only
 * because the type system cannot say otherwise: a fact extracted while the
 * embedder is down is still a fact, and relevance selection falls back to
 * name matching for it until a refresh embeds it.
 *
 * No vector index: a bible is a few hundred rows per story at most, and every
 * query filters to one story first, so an exact scan is both correct and the
 * fastest plan there is.
 *
 * Every foreign key cascades. A bible, a check and a finding are derived from
 * and private to the story they describe, so neither `deleteStory` nor
 * `deleteChapter` has to know these tables exist.
 */


export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'ai',
        table: 'chapterExtraction',
        columns: [
          col('chapterId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('contentHash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('droppedCount', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('factCount', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('model', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('promptVersion', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('storyId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('truncated', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'ai',
        table: 'continuityCheck',
        columns: [
          col('chapterId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('comparedCount', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('contentHash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('contextHash', 'text', {
            notNull: true,
            default: lit(''),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('model', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('outcome', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('promptVersion', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
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
        schema: 'ai',
        table: 'continuityDismissal',
        columns: [
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('fingerprint', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('storyId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'ai',
        table: 'continuityFinding',
        columns: [
          col('chapterId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('claimAttribute', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('claimQuote', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('claimSubject', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('claimValue', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('confidence', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('explanation', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('factAttribute', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('factOrigin', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('factQuote', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('factSubject', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('factValue', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('fingerprint', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('otherChapterId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('storyId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'ai',
        table: 'storyFact',
        columns: [
          col('attribute', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('chapterId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('embedModel', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('factKey', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('model', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('origin', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('promptVersion', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
          col('quote', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('rejected', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('related', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('storyId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('subject', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('value', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('valueKey', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      rawSql({
        id: 'column.storyFact.embedding',
        label: `Add column "embedding" vector(${EMBEDDING_DIMENSIONS}) to "storyFact"`,
        operationClass: 'additive',
        target: { id: 'postgres' },
        precheck: [],
        execute: [
          {
            description: 'Add column "embedding" to "ai"."storyFact"',
            sql:
              'ALTER TABLE "ai"."storyFact" ' +
              `ADD COLUMN "embedding" vector(${EMBEDDING_DIMENSIONS})`,
          },
        ],
        postcheck: [],
      }),
      this.addUnique({
        schema: 'ai',
        table: 'chapterExtraction',
        constraint: 'chapterExtraction_chapterId_key',
        columns: ['chapterId'],
      }),
      this.addUnique({
        schema: 'ai',
        table: 'continuityCheck',
        constraint: 'continuityCheck_chapterId_key',
        columns: ['chapterId'],
      }),
      this.addUnique({
        schema: 'ai',
        table: 'continuityDismissal',
        constraint: 'continuityDismissal_storyId_fingerprint_key',
        columns: ['storyId', 'fingerprint'],
      }),
      this.addUnique({
        schema: 'ai',
        table: 'continuityFinding',
        constraint: 'continuityFinding_chapterId_fingerprint_key',
        columns: ['chapterId', 'fingerprint'],
      }),
      this.createIndex({
        schema: 'ai',
        table: 'chapterExtraction',
        index: 'chapterExtraction_storyId_idx_cd452158',
        columns: ['storyId'],
      }),
      this.createIndex({
        schema: 'ai',
        table: 'continuityCheck',
        index: 'continuityCheck_storyId_idx_cd452158',
        columns: ['storyId'],
      }),
      this.createIndex({
        schema: 'ai',
        table: 'continuityDismissal',
        index: 'continuityDismissal_storyId_idx_cd452158',
        columns: ['storyId'],
      }),
      this.createIndex({
        schema: 'ai',
        table: 'continuityFinding',
        index: 'continuityFinding_chapterId_idx_411dd3d6',
        columns: ['chapterId'],
      }),
      this.createIndex({
        schema: 'ai',
        table: 'continuityFinding',
        index: 'continuityFinding_otherChapterId_idx_fa80d29b',
        columns: ['otherChapterId'],
      }),
      this.createIndex({
        schema: 'ai',
        table: 'continuityFinding',
        index: 'continuityFinding_storyId_idx_cd452158',
        columns: ['storyId'],
      }),
      this.createIndex({
        schema: 'ai',
        table: 'storyFact',
        index: 'storyFact_chapterId_idx_411dd3d6',
        columns: ['chapterId'],
      }),
      this.createIndex({
        schema: 'ai',
        table: 'storyFact',
        index: 'storyFact_storyId_idx_cd452158',
        columns: ['storyId'],
      }),
      this.addForeignKey({
        schema: 'ai',
        table: 'chapterExtraction',
        foreignKey: {
          name: 'chapterExtraction_storyId_fkey',
          columns: ['storyId'],
          references: { schema: 'content', table: 'story', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'ai',
        table: 'chapterExtraction',
        foreignKey: {
          name: 'chapterExtraction_chapterId_fkey',
          columns: ['chapterId'],
          references: { schema: 'content', table: 'chapter', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'ai',
        table: 'continuityCheck',
        foreignKey: {
          name: 'continuityCheck_storyId_fkey',
          columns: ['storyId'],
          references: { schema: 'content', table: 'story', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'ai',
        table: 'continuityCheck',
        foreignKey: {
          name: 'continuityCheck_chapterId_fkey',
          columns: ['chapterId'],
          references: { schema: 'content', table: 'chapter', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'ai',
        table: 'continuityDismissal',
        foreignKey: {
          name: 'continuityDismissal_storyId_fkey',
          columns: ['storyId'],
          references: { schema: 'content', table: 'story', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'ai',
        table: 'continuityFinding',
        foreignKey: {
          name: 'continuityFinding_storyId_fkey',
          columns: ['storyId'],
          references: { schema: 'content', table: 'story', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'ai',
        table: 'continuityFinding',
        foreignKey: {
          name: 'continuityFinding_chapterId_fkey',
          columns: ['chapterId'],
          references: { schema: 'content', table: 'chapter', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'ai',
        table: 'continuityFinding',
        foreignKey: {
          name: 'continuityFinding_otherChapterId_fkey',
          columns: ['otherChapterId'],
          references: { schema: 'content', table: 'chapter', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'ai',
        table: 'storyFact',
        foreignKey: {
          name: 'storyFact_storyId_fkey',
          columns: ['storyId'],
          references: { schema: 'content', table: 'story', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'ai',
        table: 'storyFact',
        foreignKey: {
          name: 'storyFact_chapterId_fkey',
          columns: ['chapterId'],
          references: { schema: 'content', table: 'chapter', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
