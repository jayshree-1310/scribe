#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/1b3e732f5fadb90ce91f88ac4c78b31a8e93ee5caf19e916bc7590aa922f4235/contract';
import startContract from '../../snapshots/1b3e732f5fadb90ce91f88ac4c78b31a8e93ee5caf19e916bc7590aa922f4235/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/e89d7b557c0039c370910c43fa29a533e5c244fdf78e295611d70ee1189c46a3/contract';
import endContract from '../../snapshots/e89d7b557c0039c370910c43fa29a533e5c244fdf78e295611d70ee1189c46a3/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit } from '@prisma/orm-postgres/migration';

/**
 * Four columns and three notification types: the state three features needed
 * and had nowhere to keep.
 *
 * **Entirely additive, and deliberately without a data transform.**
 * `auth.User.longestStreak` lands at 0 for every existing account, which is
 * *below* the streak many of them are currently on -- and that is fine,
 * because the metric reads `GREATEST("longestStreak", "readingStreak")`. The
 * column remembers only what the current streak is about to forget, so there
 * is no historical high-water mark to reconstruct and no backfill that could
 * honestly reconstruct one: `engagement.ReadingHistory` keeps the latest
 * position per story and so has forgotten every day but the last. Inventing a
 * number would be worse than starting from what we can actually prove.
 *
 * `announcedReaderLevel` / `announcedAuthorLevel` default to 1, the level
 * everybody starts at. That is the conservative direction: an account already
 * at reader level 4 is told once, on its next evaluation, that it reached
 * level 4 -- which is late but true -- rather than being silently marked as
 * already told and never hearing about the next one either.
 *
 * `userPreference.onboardingStep` defaults to 0, so a reader midway through
 * the flow when this lands resumes at step one exactly as they did before.
 * Nothing regresses; the column only starts helping once it is written.
 *
 * **The two `dropCheckConstraint` operations are a widening, not a loss.**
 * `NotificationType` is a `pg/text` column guarded by a CHECK over the allowed
 * values, so adding three means replacing that constraint rather than altering
 * a type -- the same shape the likes migration documented. The planner classes
 * a constraint drop as destructive because in general it can be; here the
 * replacement added later permits a strict superset of the same values, so no
 * existing row can fail it. The pair runs inside the migration's own
 * transaction, so there is no window in which the column is unguarded.
 */
export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'auth',
        table: 'notificationMute',
        constraint: 'notificationMute_type_check_1efec2b5',
      }),
      this.dropCheckConstraint({
        schema: 'notifications',
        table: 'notification',
        constraint: 'notification_type_check_1efec2b5',
      }),
      this.addColumn({
        schema: 'auth',
        table: 'user',
        column: col('announcedAuthorLevel', 'int4', {
          notNull: true,
          default: lit(1),
          codecRef: { codecId: 'pg/int4@1' },
        }),
      }),
      this.addColumn({
        schema: 'auth',
        table: 'user',
        column: col('announcedReaderLevel', 'int4', {
          notNull: true,
          default: lit(1),
          codecRef: { codecId: 'pg/int4@1' },
        }),
      }),
      this.addColumn({
        schema: 'auth',
        table: 'user',
        column: col('longestStreak', 'int4', {
          notNull: true,
          default: lit(0),
          codecRef: { codecId: 'pg/int4@1' },
        }),
      }),
      this.addColumn({
        schema: 'auth',
        table: 'userPreference',
        column: col('onboardingStep', 'int4', {
          notNull: true,
          default: lit(0),
          codecRef: { codecId: 'pg/int4@1' },
        }),
      }),
      this.addCheckConstraint({
        schema: 'auth',
        table: 'notificationMute',
        constraint: 'notificationMute_type_check_3a77c5c7',
        expression:
          "\"type\" IN ('CHANNEL_POST', 'COMMENT_REPLY', 'STORY_COMMENT', 'CLUB_DISCUSSION', 'NEW_STORY', 'BADGE_EARNED', 'LEVEL_UP', 'CONTENT_HIDDEN', 'REPORT_RESOLVED')",
      }),
      this.addCheckConstraint({
        schema: 'notifications',
        table: 'notification',
        constraint: 'notification_type_check_3a77c5c7',
        expression:
          "\"type\" IN ('CHANNEL_POST', 'COMMENT_REPLY', 'STORY_COMMENT', 'CLUB_DISCUSSION', 'NEW_STORY', 'BADGE_EARNED', 'LEVEL_UP', 'CONTENT_HIDDEN', 'REPORT_RESOLVED')",
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
