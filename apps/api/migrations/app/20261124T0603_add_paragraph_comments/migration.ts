#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/887bfebcdcd0e8e0fbdf2cdc394b8a165961a6c2a10acee96766c5094dd0c138/contract';
import startContract from '../../snapshots/887bfebcdcd0e8e0fbdf2cdc394b8a165961a6c2a10acee96766c5094dd0c138/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/b720b6732b227b2bfa239bdf5cfe49a6a9e3a8e0e5db3f47994dfe9c16f07d18/contract';
import endContract from '../../snapshots/b720b6732b227b2bfa239bdf5cfe49a6a9e3a8e0e5db3f47994dfe9c16f07d18/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'engagement',
        table: 'comment',
        column: col('paragraphStart', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
      }),
      this.addColumn({
        schema: 'engagement',
        table: 'comment',
        column: col('paragraphText', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
