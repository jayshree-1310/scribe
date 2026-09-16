#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/6d8f8e7f0f0212ed12a8a583909d0caed0665164e47f82d41cac62030afaf0a8/contract';
import startContract from '../../snapshots/6d8f8e7f0f0212ed12a8a583909d0caed0665164e47f82d41cac62030afaf0a8/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/f524128153dff34109d41322c22f18344d1294cc5be6da4a0deb68ffca7a2fea/contract';
import endContract from '../../snapshots/f524128153dff34109d41322c22f18344d1294cc5be6da4a0deb68ffca7a2fea/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, primaryKey } from '@prisma/orm-postgres/migration';

/**
 * Badges move from a `badge` catalogue table to a catalogue declared in
 * `services/gamification.ts`, and `userBadge` therefore keys on a `code`
 * instead of a foreign key.
 *
 * Dropped and re-created rather than altered in place. The planner's own
 * version of this change adds `code` as nullable, asks for a backfill and then
 * sets it `NOT NULL` -- but there is nothing to backfill *from*: the only
 * source of a badge's identity was the `badge` row this same migration drops,
 * and no code path has ever written `userBadge` in the first place (the award
 * engine is what this change exists to add). A backfill that could only delete
 * the rows it was asked to fill is a longer way of saying `DROP TABLE`.
 */
export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropTable({ schema: 'gamification', table: 'userBadge' }),
      this.dropTable({ schema: 'gamification', table: 'badge' }),
      this.createTable({
        schema: 'gamification',
        table: 'userBadge',
        columns: [
          col('code', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('earnedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addUnique({
        schema: 'gamification',
        table: 'userBadge',
        constraint: 'userBadge_userId_code_key',
        columns: ['userId', 'code'],
      }),
      this.createIndex({
        schema: 'gamification',
        table: 'userBadge',
        index: 'userBadge_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.addForeignKey({
        schema: 'gamification',
        table: 'userBadge',
        foreignKey: {
          name: 'userBadge_userId_fkey',
          columns: ['userId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
