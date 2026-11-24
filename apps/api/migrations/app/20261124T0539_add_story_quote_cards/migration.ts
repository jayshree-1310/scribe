#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/3ad9268a9017de126b9cf31583c92e8d3f02d321e4afba3e1419b5b5e2b8cfe4/contract';
import startContract from '../../snapshots/3ad9268a9017de126b9cf31583c92e8d3f02d321e4afba3e1419b5b5e2b8cfe4/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/887bfebcdcd0e8e0fbdf2cdc394b8a165961a6c2a10acee96766c5094dd0c138/contract';
import endContract from '../../snapshots/887bfebcdcd0e8e0fbdf2cdc394b8a165961a6c2a10acee96766c5094dd0c138/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'content',
        table: 'story',
        column: col('quoteCards', 'bool', {
          notNull: true,
          default: lit(true),
          codecRef: { codecId: 'pg/bool@1' },
        }),
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
