#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/67a9ce00722e0466a1ae2aeb83d8477e70000921add3526342f7117f9f747494/contract';
import endContract from '../../snapshots/67a9ce00722e0466a1ae2aeb83d8477e70000921add3526342f7117f9f747494/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/946c00812d2deb2e85bc8d5350ec319d2a7fc45d8f2b3a96a581845709ba723c/contract';
import startContract from '../../snapshots/946c00812d2deb2e85bc8d5350ec319d2a7fc45d8f2b3a96a581845709ba723c/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, createExtension } from '@prisma/orm-postgres/migration';

/**
 * Indexes for the list sorts and for substring search, from the load test
 * (docs/LOAD-TESTING.md).
 *
 * Additive throughout: seven indexes and an extension, no table or row
 * changes. One operation the planner did not write, because the contract
 * cannot express it:
 *
 * - **`CREATE EXTENSION pg_trgm`.** The three `gin_trgm_ops` indexes have no
 *   operator class without it. It ships with Postgres's contrib modules --
 *   the `pgvector/pgvector` image and Neon both carry it -- so unlike `vector`
 *   it needs no special image.
 *
 * Plain `CREATE INDEX`, not `CONCURRENTLY`: the framework keeps every
 * operation inside its transaction, so these take a write lock on `story`
 * and `user` while they build. At today's table sizes that is well under a
 * second; it is worth knowing before running the same shape of migration
 * against a table with millions of rows.
 */

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      // Before the indexes: `gin_trgm_ops` is defined by the extension.
      createExtension('pg_trgm'),
      this.createIndex({
        schema: 'auth',
        table: 'user',
        index: 'user_display_name_trgm_c493f926',
        expression: '"displayName" gin_trgm_ops',
        extras: { type: 'gin' },
      }),
      this.createIndex({
        schema: 'auth',
        table: 'user',
        index: 'user_username_trgm_c97ac12d',
        expression: 'username gin_trgm_ops',
        extras: { type: 'gin' },
      }),
      this.createIndex({
        schema: 'content',
        table: 'story',
        index: 'story_newest_cc3f9793',
        columns: ['listedAt', 'id'],
      }),
      this.createIndex({
        schema: 'content',
        table: 'story',
        index: 'story_rating_6ca2f6ee',
        columns: ['ratingAverage', 'id'],
      }),
      this.createIndex({
        schema: 'content',
        table: 'story',
        index: 'story_title_trgm_dbf5ca54',
        expression: 'title gin_trgm_ops',
        extras: { type: 'gin' },
      }),
      this.createIndex({
        schema: 'content',
        table: 'story',
        index: 'story_trending_a6287633',
        columns: ['likeCount', 'viewCount', 'id'],
      }),
      this.createIndex({
        schema: 'content',
        table: 'story',
        index: 'story_views_a688e443',
        columns: ['viewCount', 'id'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
