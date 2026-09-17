#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/11d6ef717b2370af5ad1259bedf477b5be0c19fa40b50801150ff67db90b4d5b/contract';
import endContract from '../../snapshots/11d6ef717b2370af5ad1259bedf477b5be0c19fa40b50801150ff67db90b4d5b/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/f524128153dff34109d41322c22f18344d1294cc5be6da4a0deb68ffca7a2fea/contract';
import startContract from '../../snapshots/f524128153dff34109d41322c22f18344d1294cc5be6da4a0deb68ffca7a2fea/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  checkExpression,
  col,
  fn,
  primaryKey,
} from '@prisma/orm-postgres/migration';

/**
 * Notifications: one table, its own schema, and nothing else changed.
 *
 * Entirely additive -- a new schema, a table, four indexes and two foreign
 * keys -- so there is no backfill and nothing to decide about existing rows.
 * A reader who signs in the day this lands simply has no notifications, which
 * is the truth: nothing was being recorded to show them.
 *
 * Both foreign keys point at `auth"."user`, so `services/account.ts` has to
 * sweep this table on `deleteAccount` from *both* sides -- the rows addressed
 * to the leaving account and the rows their actions put in other people's
 * lists. Only the first is obvious, and the second is what breaches
 * `notification_actorId_fkey`.
 *
 * `type` is a text column with a CHECK over the five values, which is what an
 * enum lowers to here. Adding a sixth is this migration again, deliberately:
 * see the header of `NotificationType` in the contract.
 */
export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createSchema({ schema: 'notifications' }),
      this.createTable({
        schema: 'notifications',
        table: 'notification',
        columns: [
          col('actorId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('excerpt', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('href', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('readAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('title', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('type', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'notification_type_check_822839ba',
            "\"type\" IN ('CHANNEL_POST', 'COMMENT_REPLY', 'CLUB_DISCUSSION', 'NEW_STORY', 'BADGE_EARNED')",
          ),
        ],
      }),
      this.createIndex({
        schema: 'notifications',
        table: 'notification',
        index: 'notification_actorId_idx_a58f6b4b',
        columns: ['actorId'],
      }),
      this.createIndex({
        schema: 'notifications',
        table: 'notification',
        index: 'notification_userId_createdAt_idx_f726f04a',
        columns: ['userId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'notifications',
        table: 'notification',
        index: 'notification_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.createIndex({
        schema: 'notifications',
        table: 'notification',
        index: 'notification_userId_readAt_idx_8bd92969',
        columns: ['userId', 'readAt'],
      }),
      this.addForeignKey({
        schema: 'notifications',
        table: 'notification',
        foreignKey: {
          name: 'notification_userId_fkey',
          columns: ['userId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'notifications',
        table: 'notification',
        foreignKey: {
          name: 'notification_actorId_fkey',
          columns: ['actorId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
