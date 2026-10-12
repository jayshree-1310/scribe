#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/0c167f3d32cb8e11103360cae4c1ec9ed7bbdaf214fef734a0c4c5e27363b96f/contract';
import startContract from '../../snapshots/0c167f3d32cb8e11103360cae4c1ec9ed7bbdaf214fef734a0c4c5e27363b96f/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/1564cbe72a2717524fd177d00afbcaef672712e0e43186ddf2baafe11ac05344/contract';
import endContract from '../../snapshots/1564cbe72a2717524fd177d00afbcaef672712e0e43186ddf2baafe11ac05344/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  checkExpression,
  col,
  fn,
  primaryKey,
} from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'ai',
        table: 'moderationDecision',
        columns: [
          col('category', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('contentHash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('failure', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('model', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('outcome', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('promptVersion', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('rejectThreshold', 'numeric', {
            notNull: true,
            codecRef: { codecId: 'pg/numeric@1' },
          }),
          col('reportId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('reviewThreshold', 'numeric', {
            notNull: true,
            codecRef: { codecId: 'pg/numeric@1' },
          }),
          col('targetId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('targetType', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'moderationDecision_outcome_check_a24db8d8',
            "\"outcome\" IN ('ALLOW', 'REVIEW', 'REJECT', 'UNCHECKED')",
          ),
          checkExpression(
            'moderationDecision_targetType_check_2c6acd2f',
            "\"targetType\" IN ('COMMENT', 'CLUB_DISCUSSION', 'CHANNEL_POST')",
          ),
        ],
      }),
      this.createTable({
        schema: 'ai',
        table: 'moderationScore',
        columns: [
          col('category', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('confidence', 'numeric', { notNull: true, codecRef: { codecId: 'pg/numeric@1' } }),
          col('decisionId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['decisionId', 'category'])],
      }),
      this.dropNotNull({ schema: 'moderation', table: 'report', column: 'reporterId' }),
      this.createIndex({
        schema: 'ai',
        table: 'moderationDecision',
        index: 'moderationDecision_outcome_createdAt_idx_f02d4ff3',
        columns: ['outcome', 'createdAt'],
      }),
      this.createIndex({
        schema: 'ai',
        table: 'moderationDecision',
        index: 'moderationDecision_reportId_idx_d163019e',
        columns: ['reportId'],
      }),
      this.createIndex({
        schema: 'ai',
        table: 'moderationDecision',
        index: 'moderationDecision_targetType_targetId_createdAt_idx_e37b8716',
        columns: ['targetType', 'targetId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'ai',
        table: 'moderationScore',
        index: 'moderationScore_decisionId_idx_8a798f77',
        columns: ['decisionId'],
      }),
      this.addForeignKey({
        schema: 'ai',
        table: 'moderationScore',
        foreignKey: {
          name: 'moderationScore_decisionId_fkey',
          columns: ['decisionId'],
          references: { schema: 'ai', table: 'moderationDecision', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
