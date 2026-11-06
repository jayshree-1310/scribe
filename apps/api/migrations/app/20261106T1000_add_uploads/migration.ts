#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/c4c461506692484099836f39eaf626650fd2b2da0d5681cb0367cdd730447bb4/contract';
import startContract from '../../snapshots/c4c461506692484099836f39eaf626650fd2b2da0d5681cb0367cdd730447bb4/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/e323dc4e1ccddcc6ca564ade500e6b7b618135e3c1effafb87e03ac462b8cf1a/contract';
import endContract from '../../snapshots/e323dc4e1ccddcc6ca564ade500e6b7b618135e3c1effafb87e03ac462b8cf1a/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, primaryKey, rawSql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'content',
        table: 'upload',
        columns: [
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('ownerId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('url', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addUnique({
        schema: 'content',
        table: 'upload',
        constraint: 'upload_url_key',
        columns: ['url'],
      }),
      this.createIndex({
        schema: 'content',
        table: 'upload',
        index: 'upload_createdAt_idx_9575dbd7',
        columns: ['createdAt'],
      }),
      this.createIndex({
        schema: 'content',
        table: 'upload',
        index: 'upload_ownerId_idx_e2d0c1ef',
        columns: ['ownerId'],
      }),
      /**
       * Records an owner for files uploaded before this table existed, from
       * the row that references each one: an avatar is its user's, a cover or
       * an attachment its story's author's. Only URLs shaped like the keys
       * `lib/storage.ts` writes (`<prefix>/<uuid>.<ext>`) are taken, so a
       * pasted remote URL never becomes a file anybody "owns". Idempotent on
       * the unique `url`; where one URL is referenced twice the first insert
       * wins, avatars first.
       */
      rawSql({
        id: 'data.content.upload.backfill',
        label: 'Backfill content.upload from existing references',
        operationClass: 'data',
        target: {
          id: 'content.upload',
          details: { schema: 'content', name: 'upload', objectType: 'table' },
        },
        precheck: [],
        execute: [
          {
            description: 'Record avatars, covers and attachments with their owners',
            sql: `INSERT INTO content."upload" ("id", "url", "ownerId", "createdAt")
                  SELECT gen_random_uuid()::text, refs.url, refs."ownerId", now()
                    FROM (
                          SELECT u."avatarUrl" AS url, u."id" AS "ownerId", 1 AS rank
                            FROM auth."user" AS u
                           WHERE u."avatarUrl" IS NOT NULL
                          UNION ALL
                          SELECT s."coverUrl", s."authorId", 2
                            FROM content."story" AS s
                           WHERE s."coverUrl" IS NOT NULL
                          UNION ALL
                          SELECT m."url", s."authorId", 3
                            FROM content."multimedia" AS m
                            JOIN content."chapter" AS c ON c."id" = m."chapterId"
                            JOIN content."story" AS s ON s."id" = c."storyId"
                         ) AS refs
                   WHERE refs.url ~ '(^|/)(avatars|covers|media)/[0-9a-f-]{36}\\.[a-z0-9]+$'
                   ORDER BY refs.rank
                  ON CONFLICT ("url") DO NOTHING`,
          },
        ],
        postcheck: [],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
