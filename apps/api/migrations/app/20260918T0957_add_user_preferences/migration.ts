#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/1c84fe4160a5ffe410d53aab6c794bbf4d2b87989c16e07e4f0eba3ca3a3125b/contract';
import startContract from '../../snapshots/1c84fe4160a5ffe410d53aab6c794bbf4d2b87989c16e07e4f0eba3ca3a3125b/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/a135d3d172d0ed837fd0fcb5011904b62ef3ed3c04ab348025ae1d0c8681d14f/contract';
import endContract from '../../snapshots/a135d3d172d0ed837fd0fcb5011904b62ef3ed3c04ab348025ae1d0c8681d14f/contract.json' with { type: 'json' };
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
 * Reader preferences: a settings row per account and two junctions beside it.
 *
 * Entirely additive -- three new tables in the existing `auth` schema, three
 * indexes, two check constraints and four foreign keys -- so there is no
 * backfill and nothing to decide about existing rows.
 *
 * **Nobody is backfilled, deliberately.** An account that predates this
 * migration has no `userPreference` row, and that is the correct state rather
 * than a gap: an absent row means "never asked", which is exactly what is true
 * of everybody today, and it is what makes the web app show them the
 * onboarding flow rather than skip it. Inserting a default row for every
 * existing user would have quietly marked the whole userbase as answered.
 *
 * `genrePreference_genreId_fkey` points at `content"."genre`, so deleting a
 * genre now has readers to consider; nothing deletes genres today.
 * `userPreference_userId_fkey`, `genrePreference_userId_fkey` and
 * `notificationMute_userId_fkey` all point at `auth"."user`, which is why
 * `deleteAccount` in `services/account.ts` sweeps all three before the user
 * row goes -- and why `TestApi.cleanup` does the same.
 */
export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'auth',
        table: 'genrePreference',
        columns: [
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('genreId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['userId', 'genreId'])],
      }),
      this.createTable({
        schema: 'auth',
        table: 'notificationMute',
        columns: [
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('type', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['userId', 'type']),
          checkExpression(
            'notificationMute_type_check_822839ba',
            "\"type\" IN ('CHANNEL_POST', 'COMMENT_REPLY', 'CLUB_DISCUSSION', 'NEW_STORY', 'BADGE_EARNED')",
          ),
        ],
      }),
      this.createTable({
        schema: 'auth',
        table: 'userPreference',
        columns: [
          col('contentLength', 'text', {
            notNull: true,
            default: lit('ANY'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('onboardingCompletedAt', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['userId']),
          checkExpression(
            'userPreference_contentLength_check_e152cea5',
            "\"contentLength\" IN ('SHORT', 'MEDIUM', 'LONG', 'ANY')",
          ),
        ],
      }),
      this.createIndex({
        schema: 'auth',
        table: 'genrePreference',
        index: 'genrePreference_genreId_idx_8fce6a7b',
        columns: ['genreId'],
      }),
      this.createIndex({
        schema: 'auth',
        table: 'genrePreference',
        index: 'genrePreference_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.createIndex({
        schema: 'auth',
        table: 'notificationMute',
        index: 'notificationMute_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.addForeignKey({
        schema: 'auth',
        table: 'genrePreference',
        foreignKey: {
          name: 'genrePreference_userId_fkey',
          columns: ['userId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'auth',
        table: 'genrePreference',
        foreignKey: {
          name: 'genrePreference_genreId_fkey',
          columns: ['genreId'],
          references: { schema: 'content', table: 'genre', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'auth',
        table: 'notificationMute',
        foreignKey: {
          name: 'notificationMute_userId_fkey',
          columns: ['userId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'auth',
        table: 'userPreference',
        foreignKey: {
          name: 'userPreference_userId_fkey',
          columns: ['userId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
