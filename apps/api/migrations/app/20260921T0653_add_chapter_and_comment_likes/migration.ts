#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/1b3e732f5fadb90ce91f88ac4c78b31a8e93ee5caf19e916bc7590aa922f4235/contract';
import endContract from '../../snapshots/1b3e732f5fadb90ce91f88ac4c78b31a8e93ee5caf19e916bc7590aa922f4235/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/a135d3d172d0ed837fd0fcb5011904b62ef3ed3c04ab348025ae1d0c8681d14f/contract';
import startContract from '../../snapshots/a135d3d172d0ed837fd0fcb5011904b62ef3ed3c04ab348025ae1d0c8681d14f/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, primaryKey } from '@prisma/orm-postgres/migration';

/**
 * Likes: two junction tables, and a sixth notification type beside them.
 *
 * Entirely additive in effect -- two new tables in the existing `engagement`
 * schema, four indexes and four foreign keys -- so there is no backfill and
 * nothing to decide about existing rows. A reader who has liked nothing has no
 * row, which is the correct state rather than a gap.
 *
 * **The two `dropCheckConstraint` operations are a widening, not a loss.**
 * `NotificationType` is a `pg/text` column guarded by a CHECK over the allowed
 * values, so adding `STORY_COMMENT` means replacing that constraint rather
 * than altering a type. The planner classes a constraint drop as destructive
 * because in general it can be; here the replacement added two operations
 * later permits a strict superset of the same six values, so no existing row
 * can fail it and nothing becomes writable that should not be. The pair runs
 * inside the migration's own transaction, so there is no window in which the
 * column is unguarded.
 *
 * Both tables key on the pair rather than a surrogate id -- see the contract
 * for why -- which is what makes a double like a primary-key conflict the
 * service can swallow instead of a duplicate row nothing could tell apart.
 */
export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'auth',
        table: 'notificationMute',
        constraint: 'notificationMute_type_check_822839ba',
      }),
      this.dropCheckConstraint({
        schema: 'notifications',
        table: 'notification',
        constraint: 'notification_type_check_822839ba',
      }),
      this.createTable({
        schema: 'engagement',
        table: 'chapterLike',
        columns: [
          col('chapterId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['userId', 'chapterId'])],
      }),
      this.createTable({
        schema: 'engagement',
        table: 'commentLike',
        columns: [
          col('commentId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['userId', 'commentId'])],
      }),
      this.addCheckConstraint({
        schema: 'auth',
        table: 'notificationMute',
        constraint: 'notificationMute_type_check_1efec2b5',
        expression:
          "\"type\" IN ('CHANNEL_POST', 'COMMENT_REPLY', 'STORY_COMMENT', 'CLUB_DISCUSSION', 'NEW_STORY', 'BADGE_EARNED')",
      }),
      this.addCheckConstraint({
        schema: 'notifications',
        table: 'notification',
        constraint: 'notification_type_check_1efec2b5',
        expression:
          "\"type\" IN ('CHANNEL_POST', 'COMMENT_REPLY', 'STORY_COMMENT', 'CLUB_DISCUSSION', 'NEW_STORY', 'BADGE_EARNED')",
      }),
      this.createIndex({
        schema: 'engagement',
        table: 'chapterLike',
        index: 'chapterLike_chapterId_idx_411dd3d6',
        columns: ['chapterId'],
      }),
      this.createIndex({
        schema: 'engagement',
        table: 'chapterLike',
        index: 'chapterLike_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.createIndex({
        schema: 'engagement',
        table: 'commentLike',
        index: 'commentLike_commentId_idx_b5a4f615',
        columns: ['commentId'],
      }),
      this.createIndex({
        schema: 'engagement',
        table: 'commentLike',
        index: 'commentLike_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.addForeignKey({
        schema: 'engagement',
        table: 'chapterLike',
        foreignKey: {
          name: 'chapterLike_userId_fkey',
          columns: ['userId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'engagement',
        table: 'chapterLike',
        foreignKey: {
          name: 'chapterLike_chapterId_fkey',
          columns: ['chapterId'],
          references: { schema: 'content', table: 'chapter', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'engagement',
        table: 'commentLike',
        foreignKey: {
          name: 'commentLike_userId_fkey',
          columns: ['userId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'engagement',
        table: 'commentLike',
        foreignKey: {
          name: 'commentLike_commentId_fkey',
          columns: ['commentId'],
          references: { schema: 'engagement', table: 'comment', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
