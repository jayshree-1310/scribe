#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/a674777e0f04c1f19f33123ac7c766a0ff7a78c99af7488a858b12609fde3076/contract';
import endContract from '../../snapshots/a674777e0f04c1f19f33123ac7c766a0ff7a78c99af7488a858b12609fde3076/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/e323dc4e1ccddcc6ca564ade500e6b7b618135e3c1effafb87e03ac462b8cf1a/contract';
import startContract from '../../snapshots/e323dc4e1ccddcc6ca564ade500e6b7b618135e3c1effafb87e03ac462b8cf1a/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'ai',
        table: 'moderationDecision',
        constraint: 'moderationDecision_targetType_check_2c6acd2f',
      }),
      this.dropCheckConstraint({
        schema: 'moderation',
        table: 'report',
        constraint: 'report_targetType_check_2c6acd2f',
      }),
      this.dropCheckConstraint({
        schema: 'notifications',
        table: 'notification',
        constraint: 'notification_sourceType_check_18693ee1',
      }),
      this.addColumn({
        schema: 'content',
        table: 'chapter',
        column: col('hiddenAt', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'content',
        table: 'chapter',
        column: col('hiddenPublishedAt', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'content',
        table: 'story',
        column: col('hiddenAt', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'content',
        table: 'story',
        column: col('hiddenListedAt', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addCheckConstraint({
        schema: 'ai',
        table: 'moderationDecision',
        constraint: 'moderationDecision_targetType_check_d2f61544',
        expression:
          "\"targetType\" IN ('COMMENT', 'CLUB_DISCUSSION', 'CHANNEL_POST', 'STORY', 'CHAPTER')",
      }),
      this.addCheckConstraint({
        schema: 'moderation',
        table: 'report',
        constraint: 'report_targetType_check_d2f61544',
        expression:
          "\"targetType\" IN ('COMMENT', 'CLUB_DISCUSSION', 'CHANNEL_POST', 'STORY', 'CHAPTER')",
      }),
      this.addCheckConstraint({
        schema: 'notifications',
        table: 'notification',
        constraint: 'notification_sourceType_check_800baecb',
        expression:
          "\"sourceType\" IN ('COMMENT', 'CLUB_DISCUSSION', 'CHANNEL_POST', 'STORY', 'CHAPTER')",
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
