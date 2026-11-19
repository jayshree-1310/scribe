#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/0d941e650b2d4a18b2c6d1710cd80323c32e63d95331a3d55f0a723480d89e06/contract';
import endContract from '../../snapshots/0d941e650b2d4a18b2c6d1710cd80323c32e63d95331a3d55f0a723480d89e06/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/a674777e0f04c1f19f33123ac7c766a0ff7a78c99af7488a858b12609fde3076/contract';
import startContract from '../../snapshots/a674777e0f04c1f19f33123ac7c766a0ff7a78c99af7488a858b12609fde3076/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'ai',
        table: 'moderationDecision',
        constraint: 'moderationDecision_targetType_check_d2f61544',
      }),
      this.dropCheckConstraint({
        schema: 'moderation',
        table: 'report',
        constraint: 'report_targetType_check_d2f61544',
      }),
      this.dropCheckConstraint({
        schema: 'notifications',
        table: 'notification',
        constraint: 'notification_sourceType_check_800baecb',
      }),
      this.addColumn({
        schema: 'auth',
        table: 'user',
        column: col('hiddenAvatarUrl', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'auth',
        table: 'user',
        column: col('hiddenBio', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'auth',
        table: 'user',
        column: col('hiddenDisplayName', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'auth',
        table: 'user',
        column: col('profileHiddenAt', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'channels',
        table: 'broadcastChannel',
        column: col('hiddenAt', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'clubs',
        table: 'bookClub',
        column: col('hiddenAt', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addCheckConstraint({
        schema: 'ai',
        table: 'moderationDecision',
        constraint: 'moderationDecision_targetType_check_4fe6a63e',
        expression:
          "\"targetType\" IN ('COMMENT', 'CLUB_DISCUSSION', 'CHANNEL_POST', 'STORY', 'CHAPTER', 'PROFILE', 'CLUB', 'CHANNEL')",
      }),
      this.addCheckConstraint({
        schema: 'moderation',
        table: 'report',
        constraint: 'report_targetType_check_4fe6a63e',
        expression:
          "\"targetType\" IN ('COMMENT', 'CLUB_DISCUSSION', 'CHANNEL_POST', 'STORY', 'CHAPTER', 'PROFILE', 'CLUB', 'CHANNEL')",
      }),
      this.addCheckConstraint({
        schema: 'notifications',
        table: 'notification',
        constraint: 'notification_sourceType_check_f9b36c93',
        expression:
          "\"sourceType\" IN ('COMMENT', 'CLUB_DISCUSSION', 'CHANNEL_POST', 'STORY', 'CHAPTER', 'PROFILE', 'CLUB', 'CHANNEL')",
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
