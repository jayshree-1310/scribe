#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/635824784b98792ea123199a1c0fc7c01fa647c37584c288704e0d342507d931/contract';
import startContract from '../../snapshots/635824784b98792ea123199a1c0fc7c01fa647c37584c288704e0d342507d931/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/b14ab879de7df6f1227004c5b4312618a4ab9132ffab232da3fd955fbb3251c2/contract';
import endContract from '../../snapshots/b14ab879de7df6f1227004c5b4312618a4ab9132ffab232da3fd955fbb3251c2/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, lit, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'ai',
        table: 'usageEvent',
        columns: [
          col('cachedTokens', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('durationMs', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('errorCode', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('feature', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('inputTokens', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('model', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('outcome', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('outputTokens', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('provider', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('userId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createIndex({
        schema: 'ai',
        table: 'usageEvent',
        index: 'usageEvent_createdAt_feature_idx_8158c4b2',
        columns: ['createdAt', 'feature'],
      }),
      this.createIndex({
        schema: 'ai',
        table: 'usageEvent',
        index: 'usageEvent_userId_createdAt_idx_f726f04a',
        columns: ['userId', 'createdAt'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
