#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/3e097fcdd1e171f1128ccb37aef53aeb02b160f047e0143ebf78524a8096a844/contract';
import startContract from '../../snapshots/3e097fcdd1e171f1128ccb37aef53aeb02b160f047e0143ebf78524a8096a844/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/d7f3d5ce2f31e0ce355c371c9b81727e91d49585529c768d0616b3b594470d70/contract';
import endContract from '../../snapshots/d7f3d5ce2f31e0ce355c371c9b81727e91d49585529c768d0616b3b594470d70/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  col,
  fn,
  primaryKey,
  rawSql,
} from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'clubs',
        table: 'clubDiscussion',
        columns: [
          col('body', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('clubId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('parentId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addColumn({
        schema: 'clubs',
        table: 'bookClub',
        column: col('currentStoryId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'channels',
        table: 'broadcastChannel',
        column: col('slug', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      /**
       * Backfills the slug for channels that predate the column, by the same
       * rules -- and for the same reasons -- as the story slug backfill in
       * `20260910T0557_*`: a single set-based UPDATE whose tie-breaking needs a
       * window function the query builder cannot express, guarded on `IS NULL`
       * so a re-run is a no-op rather than a second pass.
       *
       * There are no such rows today: clubs and channels have never had
       * endpoints, so both tables are empty. The statement is written to be
       * correct anyway rather than as a no-op, because it is what would run
       * against an environment where they are not.
       */
      rawSql({
        id: 'data.channels.broadcastChannel.backfill-slug',
        label: 'Backfill channels.broadcastChannel.slug from names',
        operationClass: 'data',
        target: {
          id: 'channels.broadcastChannel',
          details: { schema: 'channels', name: 'broadcastChannel', objectType: 'table' },
        },
        precheck: [],
        execute: [
          {
            description: 'Derive a unique slug per channel from its name',
            sql: `UPDATE channels."broadcastChannel" AS c
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
                                                     trim(BOTH '-' FROM regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')),
                                                     ''
                                                   ),
                                                   'channel'
                                                 ) AS base
                                            FROM channels."broadcastChannel"
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
      this.setNotNull({ schema: 'channels', table: 'broadcastChannel', column: 'slug' }),
      this.addColumn({
        schema: 'channels',
        table: 'channelPost',
        column: col('title', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      /**
       * A post that predates the title column has only its body to name it, so
       * the first line stands in -- truncated, because a body's first line can
       * be a whole paragraph. Titles are not unique, so no numbering is needed.
       */
      rawSql({
        id: 'data.channels.channelPost.backfill-title',
        label: 'Backfill channels.channelPost.title from the body',
        operationClass: 'data',
        target: {
          id: 'channels.channelPost',
          details: { schema: 'channels', name: 'channelPost', objectType: 'table' },
        },
        precheck: [],
        execute: [
          {
            description: 'Take the first line of the body as the title',
            sql: `UPDATE channels."channelPost"
                     SET "title" = COALESCE(
                           NULLIF(left(trim(split_part("content", E'\\n', 1)), 120), ''),
                           'Untitled post'
                         )
                   WHERE "title" IS NULL`,
          },
        ],
        postcheck: [],
      }),
      this.setNotNull({ schema: 'channels', table: 'channelPost', column: 'title' }),
      this.addColumn({
        schema: 'clubs',
        table: 'bookClub',
        column: col('slug', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      /** The channel slug backfill above, against the club table. */
      rawSql({
        id: 'data.clubs.bookClub.backfill-slug',
        label: 'Backfill clubs.bookClub.slug from names',
        operationClass: 'data',
        target: {
          id: 'clubs.bookClub',
          details: { schema: 'clubs', name: 'bookClub', objectType: 'table' },
        },
        precheck: [],
        execute: [
          {
            description: 'Derive a unique slug per club from its name',
            sql: `UPDATE clubs."bookClub" AS b
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
                                                     trim(BOTH '-' FROM regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')),
                                                     ''
                                                   ),
                                                   'club'
                                                 ) AS base
                                            FROM clubs."bookClub"
                                           WHERE "slug" IS NULL
                                         ) AS slugged
                                 ) AS numbered
                         ) AS candidate
                   WHERE b.id = candidate.id
                     AND b."slug" IS NULL`,
          },
        ],
        postcheck: [],
      }),
      this.setNotNull({ schema: 'clubs', table: 'bookClub', column: 'slug' }),
      this.addUnique({
        schema: 'channels',
        table: 'broadcastChannel',
        constraint: 'broadcastChannel_slug_key',
        columns: ['slug'],
      }),
      this.addUnique({
        schema: 'clubs',
        table: 'bookClub',
        constraint: 'bookClub_slug_key',
        columns: ['slug'],
      }),
      this.createIndex({
        schema: 'channels',
        table: 'channelPost',
        index: 'channelPost_channelId_postedAt_idx_39fe8d82',
        columns: ['channelId', 'postedAt'],
      }),
      this.createIndex({
        schema: 'clubs',
        table: 'bookClub',
        index: 'bookClub_currentStoryId_idx_76f32fbb',
        columns: ['currentStoryId'],
      }),
      this.createIndex({
        schema: 'clubs',
        table: 'clubDiscussion',
        index: 'clubDiscussion_clubId_idx_7aff947d',
        columns: ['clubId'],
      }),
      this.createIndex({
        schema: 'clubs',
        table: 'clubDiscussion',
        index: 'clubDiscussion_clubId_parentId_createdAt_idx_844f84c4',
        columns: ['clubId', 'parentId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'clubs',
        table: 'clubDiscussion',
        index: 'clubDiscussion_parentId_idx_6a68f597',
        columns: ['parentId'],
      }),
      this.createIndex({
        schema: 'clubs',
        table: 'clubDiscussion',
        index: 'clubDiscussion_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.addForeignKey({
        schema: 'clubs',
        table: 'bookClub',
        foreignKey: {
          name: 'bookClub_currentStoryId_fkey',
          columns: ['currentStoryId'],
          references: { schema: 'content', table: 'story', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'clubs',
        table: 'clubDiscussion',
        foreignKey: {
          name: 'clubDiscussion_clubId_fkey',
          columns: ['clubId'],
          references: { schema: 'clubs', table: 'bookClub', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'clubs',
        table: 'clubDiscussion',
        foreignKey: {
          name: 'clubDiscussion_userId_fkey',
          columns: ['userId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'clubs',
        table: 'clubDiscussion',
        foreignKey: {
          name: 'clubDiscussion_parentId_fkey',
          columns: ['parentId'],
          references: { schema: 'clubs', table: 'clubDiscussion', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
