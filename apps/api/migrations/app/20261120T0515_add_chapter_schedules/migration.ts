#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/0d941e650b2d4a18b2c6d1710cd80323c32e63d95331a3d55f0a723480d89e06/contract';
import startContract from '../../snapshots/0d941e650b2d4a18b2c6d1710cd80323c32e63d95331a3d55f0a723480d89e06/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/946c00812d2deb2e85bc8d5350ec319d2a7fc45d8f2b3a96a581845709ba723c/contract';
import endContract from '../../snapshots/946c00812d2deb2e85bc8d5350ec319d2a7fc45d8f2b3a96a581845709ba723c/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'auth',
        table: 'notificationMute',
        constraint: 'notificationMute_type_check_3a77c5c7',
      }),
      this.dropCheckConstraint({
        schema: 'notifications',
        table: 'notification',
        constraint: 'notification_type_check_3a77c5c7',
      }),
      this.addColumn({
        schema: 'content',
        table: 'chapter',
        column: col('scheduledAt', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addCheckConstraint({
        schema: 'auth',
        table: 'notificationMute',
        constraint: 'notificationMute_type_check_fd2b9b0f',
        expression:
          "\"type\" IN ('CHANNEL_POST', 'COMMENT_REPLY', 'STORY_COMMENT', 'CLUB_DISCUSSION', 'NEW_STORY', 'NEW_CHAPTER', 'BADGE_EARNED', 'LEVEL_UP', 'CONTENT_HIDDEN', 'REPORT_RESOLVED')",
      }),
      this.addCheckConstraint({
        schema: 'notifications',
        table: 'notification',
        constraint: 'notification_type_check_fd2b9b0f',
        expression:
          "\"type\" IN ('CHANNEL_POST', 'COMMENT_REPLY', 'STORY_COMMENT', 'CLUB_DISCUSSION', 'NEW_STORY', 'NEW_CHAPTER', 'BADGE_EARNED', 'LEVEL_UP', 'CONTENT_HIDDEN', 'REPORT_RESOLVED')",
      }),
      this.createIndex({
        schema: 'content',
        table: 'chapter',
        index: 'chapter_scheduledAt_idx_f69c1204',
        columns: ['scheduledAt'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
