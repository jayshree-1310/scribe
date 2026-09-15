#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/dd92396eafcc15822b31c2fd407f9a61c78ef5bf988cc7681ae670d473e8bc6a/contract';
import startContract from '../../snapshots/dd92396eafcc15822b31c2fd407f9a61c78ef5bf988cc7681ae670d473e8bc6a/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/efd4d8e5f424a80aab08e125ffc91d1c0f204592b83ceb11c95cf4736a5f58f2/contract';
import endContract from '../../snapshots/efd4d8e5f424a80aab08e125ffc91d1c0f204592b83ceb11c95cf4736a5f58f2/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, lit, rawSql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropConstraint({
        schema: 'challenges',
        table: 'challengeEntry',
        constraint: 'challengeEntry_challengeId_userId_storyId_key',
      }),
      this.addColumn({
        schema: 'auth',
        table: 'user',
        column: col('isAdmin', 'bool', {
          notNull: true,
          default: lit(false),
          codecRef: { codecId: 'pg/bool@1' },
        }),
      }),
      this.addColumn({
        schema: 'challenges',
        table: 'challengeEntry',
        column: col('note', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'challenges',
        table: 'challengeEntry',
        column: col('updatedAt', 'timestamptz', {
          notNull: true,
          default: fn('now()'),
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'challenges',
        table: 'writingChallenge',
        column: col('updatedAt', 'timestamptz', {
          notNull: true,
          default: fn('now()'),
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'challenges',
        table: 'writingChallenge',
        column: col('wordTarget', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
      }),
      this.addColumn({
        schema: 'challenges',
        table: 'writingChallenge',
        column: col('hostId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      /**
       * Backfills the three columns above for rows that predate them.
       *
       * Written as raw statements rather than `dataTransform` closures for the
       * reason the story-slug migration gives: each is a single set-based
       * UPDATE guarded by its own `IS NULL`, so a re-run is a no-op, and the
       * slug derivation needs a window function the query builder cannot
       * express.
       *
       * All three are unreachable in practice. No route, service, seed or
       * fixture in this repository has ever written `challenges.writingChallenge`
       * -- the feature is being built in the same change as this migration --
       * so the table is empty and every statement matches nothing. They exist
       * because the `SET NOT NULL` that follows each one must not be able to
       * fail on a row written from outside the app.
       *
       * There is no admin to attribute an orphan challenge to: `isAdmin`
       * arrives in this same migration, so every account is a non-admin at
       * this point. The oldest account is the only deterministic choice left.
       */
      rawSql({
        id: 'data.challenges.writingChallenge.backfill-host-id',
        label: 'Attribute host-less challenges to the oldest account',
        operationClass: 'data',
        target: {
          id: 'challenges.writingChallenge',
          details: { schema: 'challenges', name: 'writingChallenge', objectType: 'table' },
        },
        precheck: [],
        execute: [
          {
            description: 'Set hostId on rows that predate the column',
            sql: `UPDATE challenges."writingChallenge" AS c
                     SET "hostId" = (
                           SELECT u."id"
                             FROM auth."user" AS u
                            ORDER BY u."createdAt", u."id"
                            LIMIT 1
                         )
                   WHERE c."hostId" IS NULL`,
          },
        ],
        postcheck: [],
      }),
      this.setNotNull({ schema: 'challenges', table: 'writingChallenge', column: 'hostId' }),
      this.addColumn({
        schema: 'challenges',
        table: 'writingChallenge',
        column: col('prompt', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      /**
       * A challenge written before `prompt` existed kept its whole brief in
       * `description`, which is the closest thing to one; a row with neither
       * falls back to its title so the column can be made NOT NULL.
       */
      rawSql({
        id: 'data.challenges.writingChallenge.backfill-prompt',
        label: 'Derive a prompt for challenges that predate the column',
        operationClass: 'data',
        target: {
          id: 'challenges.writingChallenge',
          details: { schema: 'challenges', name: 'writingChallenge', objectType: 'table' },
        },
        precheck: [],
        execute: [
          {
            description: 'Set prompt from the description, or the title when there is none',
            sql: `UPDATE challenges."writingChallenge"
                     SET "prompt" = COALESCE(NULLIF(btrim("description"), ''), "title")
                   WHERE "prompt" IS NULL`,
          },
        ],
        postcheck: [],
      }),
      this.setNotNull({ schema: 'challenges', table: 'writingChallenge', column: 'prompt' }),
      this.addColumn({
        schema: 'challenges',
        table: 'writingChallenge',
        column: col('slug', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      /**
       * The same derivation `content.story` got, and for the same reasons:
       * titles are not unique and the column is about to become UNIQUE, so
       * equal titles are ordered by age and every one after the first takes a
       * numeric suffix; a title made only of punctuation slugifies to the
       * empty string, hence the 'challenge' fallback, which then goes through
       * the same numbering. It matches `lib/slug.ts`, which is what every
       * later row goes through.
       */
      rawSql({
        id: 'data.challenges.writingChallenge.backfill-slug',
        label: 'Backfill challenges.writingChallenge.slug from titles',
        operationClass: 'data',
        target: {
          id: 'challenges.writingChallenge',
          details: { schema: 'challenges', name: 'writingChallenge', objectType: 'table' },
        },
        precheck: [],
        execute: [
          {
            description: 'Derive a unique slug per challenge from its title',
            sql: `UPDATE challenges."writingChallenge" AS c
                     SET "slug" = candidate.slug
                    FROM (
                          SELECT id,
                                 base || CASE WHEN rn = 1 THEN '' ELSE '-' || rn::text END AS slug
                            FROM (
                                  SELECT id,
                                         base,
                                         row_number() OVER (PARTITION BY base ORDER BY "createdAt", id) AS rn
                                    FROM (
                                          SELECT id,
                                                 "createdAt",
                                                 COALESCE(
                                                   NULLIF(
                                                     trim(BOTH '-' FROM regexp_replace(lower(title), '[^a-z0-9]+', '-', 'g')),
                                                     ''
                                                   ),
                                                   'challenge'
                                                 ) AS base
                                            FROM challenges."writingChallenge"
                                           WHERE "slug" IS NULL
                                         ) AS slugged
                                 ) AS numbered
                         ) AS candidate
                   WHERE c.id = candidate.id
                     AND c."slug" IS NULL`,
          },
        ],
        postcheck: [],
      }),
      this.setNotNull({ schema: 'challenges', table: 'writingChallenge', column: 'slug' }),
      this.dropNotNull({ schema: 'challenges', table: 'challengeEntry', column: 'storyId' }),
      this.addUnique({
        schema: 'challenges',
        table: 'challengeEntry',
        constraint: 'challengeEntry_challengeId_userId_key',
        columns: ['challengeId', 'userId'],
      }),
      this.addUnique({
        schema: 'challenges',
        table: 'writingChallenge',
        constraint: 'writingChallenge_slug_key',
        columns: ['slug'],
      }),
      this.createIndex({
        schema: 'challenges',
        table: 'writingChallenge',
        index: 'writingChallenge_hostId_idx_05205577',
        columns: ['hostId'],
      }),
      this.createIndex({
        schema: 'challenges',
        table: 'writingChallenge',
        index: 'writingChallenge_startAt_endAt_idx_9d707d87',
        columns: ['startAt', 'endAt'],
      }),
      this.addForeignKey({
        schema: 'challenges',
        table: 'writingChallenge',
        foreignKey: {
          name: 'writingChallenge_hostId_fkey',
          columns: ['hostId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
