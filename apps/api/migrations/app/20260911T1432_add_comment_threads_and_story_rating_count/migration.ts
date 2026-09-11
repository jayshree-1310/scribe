#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/bec91705027d519b853ac1db47e1bc3e0cbce132a72233a50519629b230f299a/contract';
import endContract from '../../snapshots/bec91705027d519b853ac1db47e1bc3e0cbce132a72233a50519629b230f299a/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/d7f3d5ce2f31e0ce355c371c9b81727e91d49585529c768d0616b3b594470d70/contract';
import startContract from '../../snapshots/d7f3d5ce2f31e0ce355c371c9b81727e91d49585529c768d0616b3b594470d70/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'content',
        table: 'story',
        column: col('ratingCount', 'int4', {
          notNull: true,
          default: lit(0),
          codecRef: { codecId: 'pg/int4@1' },
        }),
      }),
      this.addColumn({
        schema: 'engagement',
        table: 'comment',
        column: col('parentId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.createIndex({
        schema: 'engagement',
        table: 'comment',
        index: 'comment_parentId_idx_6a68f597',
        columns: ['parentId'],
      }),
      this.addForeignKey({
        schema: 'engagement',
        table: 'comment',
        foreignKey: {
          name: 'comment_parentId_fkey',
          columns: ['parentId'],
          references: { schema: 'engagement', table: 'comment', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
