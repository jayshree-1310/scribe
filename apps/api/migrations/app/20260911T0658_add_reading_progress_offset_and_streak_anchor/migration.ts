#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/3e097fcdd1e171f1128ccb37aef53aeb02b160f047e0143ebf78524a8096a844/contract';
import endContract from '../../snapshots/3e097fcdd1e171f1128ccb37aef53aeb02b160f047e0143ebf78524a8096a844/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/f3ad3aa752ccc8276d2e5a845eab61c409f5440c1d95b60b03935f5367e3a34a/contract';
import startContract from '../../snapshots/f3ad3aa752ccc8276d2e5a845eab61c409f5440c1d95b60b03935f5367e3a34a/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'auth',
        table: 'user',
        column: col('streakLastReadAt', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'engagement',
        table: 'readingHistory',
        column: col('offset', 'int4', {
          notNull: true,
          default: lit(0),
          codecRef: { codecId: 'pg/int4@1' },
        }),
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
