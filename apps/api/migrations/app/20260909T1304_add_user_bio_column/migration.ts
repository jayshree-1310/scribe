#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/28de4e98f951d4018265faec4e326b9f947b47f9ae6763498eed0838cd22fc9b/contract';
import startContract from '../../snapshots/28de4e98f951d4018265faec4e326b9f947b47f9ae6763498eed0838cd22fc9b/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/3dc2d7db681b6f876555fe26b14e0f97bf3bbb59361460e0564296eda9bfea21/contract';
import endContract from '../../snapshots/3dc2d7db681b6f876555fe26b14e0f97bf3bbb59361460e0564296eda9bfea21/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'auth',
        table: 'user',
        column: col('bio', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
