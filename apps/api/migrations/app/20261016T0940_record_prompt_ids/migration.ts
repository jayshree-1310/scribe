#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/1564cbe72a2717524fd177d00afbcaef672712e0e43186ddf2baafe11ac05344/contract';
import startContract from '../../snapshots/1564cbe72a2717524fd177d00afbcaef672712e0e43186ddf2baafe11ac05344/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/635824784b98792ea123199a1c0fc7c01fa647c37584c288704e0d342507d931/contract';
import endContract from '../../snapshots/635824784b98792ea123199a1c0fc7c01fa647c37584c288704e0d342507d931/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'ai',
        table: 'chapterExtraction',
        column: col('promptId', 'text', {
          notNull: true,
          default: lit('story-bible.extract'),
          codecRef: { codecId: 'pg/text@1' },
        }),
      }),
      this.addColumn({
        schema: 'ai',
        table: 'chapterSummary',
        column: col('promptId', 'text', {
          notNull: true,
          default: lit('recap'),
          codecRef: { codecId: 'pg/text@1' },
        }),
      }),
      this.addColumn({
        schema: 'ai',
        table: 'continuityCheck',
        column: col('promptId', 'text', {
          notNull: true,
          default: lit('continuity'),
          codecRef: { codecId: 'pg/text@1' },
        }),
      }),
      this.addColumn({
        schema: 'ai',
        table: 'conversation',
        column: col('summaryPromptId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'ai',
        table: 'conversation',
        column: col('summaryPromptVersion', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
      }),
      this.addColumn({
        schema: 'ai',
        table: 'conversationMessage',
        column: col('promptId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'ai',
        table: 'conversationMessage',
        column: col('promptVersion', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
      }),
      this.addColumn({
        schema: 'ai',
        table: 'moderationDecision',
        column: col('promptId', 'text', {
          notNull: true,
          default: lit('moderation'),
          codecRef: { codecId: 'pg/text@1' },
        }),
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
