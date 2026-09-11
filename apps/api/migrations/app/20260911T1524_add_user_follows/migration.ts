#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/bec91705027d519b853ac1db47e1bc3e0cbce132a72233a50519629b230f299a/contract';
import startContract from '../../snapshots/bec91705027d519b853ac1db47e1bc3e0cbce132a72233a50519629b230f299a/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/dd92396eafcc15822b31c2fd407f9a61c78ef5bf988cc7681ae670d473e8bc6a/contract';
import endContract from '../../snapshots/dd92396eafcc15822b31c2fd407f9a61c78ef5bf988cc7681ae670d473e8bc6a/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'engagement',
        table: 'follow',
        columns: [
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('followerId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('followingId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addUnique({
        schema: 'engagement',
        table: 'follow',
        constraint: 'follow_followerId_followingId_key',
        columns: ['followerId', 'followingId'],
      }),
      this.createIndex({
        schema: 'engagement',
        table: 'follow',
        index: 'follow_followerId_createdAt_idx_04c22e1e',
        columns: ['followerId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'engagement',
        table: 'follow',
        index: 'follow_followerId_idx_2aa6c62d',
        columns: ['followerId'],
      }),
      this.createIndex({
        schema: 'engagement',
        table: 'follow',
        index: 'follow_followingId_createdAt_idx_789d8a0b',
        columns: ['followingId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'engagement',
        table: 'follow',
        index: 'follow_followingId_idx_1cf16645',
        columns: ['followingId'],
      }),
      this.addForeignKey({
        schema: 'engagement',
        table: 'follow',
        foreignKey: {
          name: 'follow_followerId_fkey',
          columns: ['followerId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'engagement',
        table: 'follow',
        foreignKey: {
          name: 'follow_followingId_fkey',
          columns: ['followingId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
