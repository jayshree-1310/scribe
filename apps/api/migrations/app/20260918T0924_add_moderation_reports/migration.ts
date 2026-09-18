#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/11d6ef717b2370af5ad1259bedf477b5be0c19fa40b50801150ff67db90b4d5b/contract';
import startContract from '../../snapshots/11d6ef717b2370af5ad1259bedf477b5be0c19fa40b50801150ff67db90b4d5b/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/1c84fe4160a5ffe410d53aab6c794bbf4d2b87989c16e07e4f0eba3ca3a3125b/contract';
import endContract from '../../snapshots/1c84fe4160a5ffe410d53aab6c794bbf4d2b87989c16e07e4f0eba3ca3a3125b/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  checkExpression,
  col,
  fn,
  lit,
  primaryKey,
} from '@prisma/orm-postgres/migration';

/**
 * Moderation: a report table, a suspension column, three hide columns, and
 * two columns telling a notification what it quoted.
 *
 * Entirely additive -- a new schema, a table, six nullable columns, five
 * indexes, two check constraints and two foreign keys -- so there is no
 * backfill and nothing to decide about existing rows. Every `hiddenAt` starts
 * null, which is exactly right: nothing has been hidden, because until now
 * nothing could be.
 *
 * The two `notification` columns are the deliberate exception to that
 * comfort. Rows written before this migration have a null `sourceType`, so
 * the sweep in `hideContent` cannot find the excerpts they copied and leaves
 * them alone. Backfilling them is not possible -- `excerpt` is a prefix of a
 * body, not a key -- and pretending otherwise with a `LIKE` join over two
 * tables would be a guess that sometimes deleted the wrong person's
 * notification. See the header of `services/moderation.ts`.
 *
 * `report_reporterId_fkey` and `report_resolvedById_fkey` both point at
 * `auth"."user`, so `services/account.ts` has to reach this table on
 * `deleteAccount` from both sides -- and treats them differently: the reports
 * an account filed go with it, and the ones it resolved keep the record and
 * drop the name.
 */
export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createSchema({ schema: 'moderation' }),
      this.createTable({
        schema: 'moderation',
        table: 'report',
        columns: [
          col('action', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('details', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('note', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('reason', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('reporterId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('resolvedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('resolvedById', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('OPEN'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('targetId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('targetType', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'report_action_check_5f2de721',
            "\"action\" IN ('DISMISS', 'HIDE', 'SUSPEND')",
          ),
          checkExpression(
            'report_reason_check_735e3aeb',
            "\"reason\" IN ('SPAM', 'HARASSMENT', 'HATE', 'SEXUAL', 'VIOLENCE', 'SPOILER', 'OTHER')",
          ),
          checkExpression('report_status_check_2a206a64', "\"status\" IN ('OPEN', 'RESOLVED')"),
          checkExpression(
            'report_targetType_check_2c6acd2f',
            "\"targetType\" IN ('COMMENT', 'CLUB_DISCUSSION', 'CHANNEL_POST')",
          ),
        ],
      }),
      this.addColumn({
        schema: 'auth',
        table: 'user',
        column: col('suspendedAt', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'channels',
        table: 'channelPost',
        column: col('hiddenAt', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'clubs',
        table: 'clubDiscussion',
        column: col('hiddenAt', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'engagement',
        table: 'comment',
        column: col('hiddenAt', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'notifications',
        table: 'notification',
        column: col('sourceId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'notifications',
        table: 'notification',
        column: col('sourceType', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addCheckConstraint({
        schema: 'notifications',
        table: 'notification',
        constraint: 'notification_sourceType_check_18693ee1',
        expression: "\"sourceType\" IN ('COMMENT', 'CLUB_DISCUSSION', 'CHANNEL_POST')",
      }),
      this.createIndex({
        schema: 'moderation',
        table: 'report',
        index: 'report_reporterId_idx_aa245831',
        columns: ['reporterId'],
      }),
      this.createIndex({
        schema: 'moderation',
        table: 'report',
        index: 'report_resolvedById_idx_fc75edc7',
        columns: ['resolvedById'],
      }),
      this.createIndex({
        schema: 'moderation',
        table: 'report',
        index: 'report_status_createdAt_idx_58610442',
        columns: ['status', 'createdAt'],
      }),
      this.createIndex({
        schema: 'moderation',
        table: 'report',
        index: 'report_targetType_targetId_status_idx_f4be9279',
        columns: ['targetType', 'targetId', 'status'],
      }),
      this.createIndex({
        schema: 'notifications',
        table: 'notification',
        index: 'notification_sourceType_sourceId_idx_9b8c3bc3',
        columns: ['sourceType', 'sourceId'],
      }),
      this.addForeignKey({
        schema: 'moderation',
        table: 'report',
        foreignKey: {
          name: 'report_reporterId_fkey',
          columns: ['reporterId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'moderation',
        table: 'report',
        foreignKey: {
          name: 'report_resolvedById_fkey',
          columns: ['resolvedById'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
