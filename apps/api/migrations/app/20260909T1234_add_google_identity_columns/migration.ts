#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/28de4e98f951d4018265faec4e326b9f947b47f9ae6763498eed0838cd22fc9b/contract';
import endContract from '../../snapshots/28de4e98f951d4018265faec4e326b9f947b47f9ae6763498eed0838cd22fc9b/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/61cd8b821c72071de38ad69cfea3f87d9c013f889c389c048eb92d83cec6878f/contract';
import startContract from '../../snapshots/61cd8b821c72071de38ad69cfea3f87d9c013f889c389c048eb92d83cec6878f/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'auth',
        table: 'user',
        column: col('avatarUrl', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'auth',
        table: 'user',
        column: col('displayName', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'auth',
        table: 'user',
        column: col('emailVerified', 'bool', {
          notNull: true,
          default: lit(false),
          codecRef: { codecId: 'pg/bool@1' },
        }),
      }),
      this.addColumn({
        schema: 'auth',
        table: 'user',
        column: col('googleId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.dropNotNull({ schema: 'auth', table: 'user', column: 'passwordHash' }),
      this.addUnique({
        schema: 'auth',
        table: 'user',
        constraint: 'user_googleId_key',
        columns: ['googleId'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
