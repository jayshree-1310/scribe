#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/3dc2d7db681b6f876555fe26b14e0f97bf3bbb59361460e0564296eda9bfea21/contract';
import startContract from '../../snapshots/3dc2d7db681b6f876555fe26b14e0f97bf3bbb59361460e0564296eda9bfea21/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/f3ad3aa752ccc8276d2e5a845eab61c409f5440c1d95b60b03935f5367e3a34a/contract';
import endContract from '../../snapshots/f3ad3aa752ccc8276d2e5a845eab61c409f5440c1d95b60b03935f5367e3a34a/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit, rawSql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'content',
        table: 'chapter',
        column: col('wordCount', 'int4', {
          notNull: true,
          default: lit(0),
          codecRef: { codecId: 'pg/int4@1' },
        }),
      }),
      this.addColumn({
        schema: 'content',
        table: 'story',
        column: col('listedAt', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'content',
        table: 'story',
        column: col('source', 'text', {
          notNull: true,
          default: lit('SCRIBE'),
          codecRef: { codecId: 'pg/text@1' },
        }),
      }),
      this.addColumn({
        schema: 'content',
        table: 'story',
        column: col('slug', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      /**
       * Backfills the three columns above for rows that predate them.
       *
       * Written as raw statements rather than `dataTransform` closures because
       * each one is a single set-based UPDATE -- the slug derivation needs a
       * window function to break ties, which the query builder cannot express
       * -- and because every statement is idempotent on its own `IS NULL`
       * guard, so a re-run is a no-op rather than a second pass.
       */
      rawSql({
        id: 'data.content.story.backfill-slug',
        label: 'Backfill content.story.slug from titles',
        operationClass: 'data',
        target: {
          id: 'content.story',
          details: { schema: 'content', name: 'story', objectType: 'table' },
        },
        precheck: [],
        execute: [
          {
            description: 'Derive a unique slug per story from its title',
            // Titles are not unique in principle, and the column is about to
            // become UNIQUE, so equal titles are ordered by age and every one
            // after the first takes a numeric suffix. A title made entirely of
            // punctuation slugifies to the empty string, which would collide
            // with every other such title -- hence the 'story' fallback, which
            // then goes through the same numbering.
            sql: `UPDATE content."story" AS s
                     SET "slug" = candidate.slug
                    FROM (
                          SELECT id,
                                 base || CASE WHEN rn = 1 THEN '' ELSE '-' || rn::text END AS slug
                            FROM (
                                  SELECT id,
                                         base,
                                         row_number() OVER (PARTITION BY base ORDER BY "createdAt", id) AS rn
                                    FROM (
                                          SELECT id,
                                                 "createdAt",
                                                 COALESCE(
                                                   NULLIF(
                                                     trim(BOTH '-' FROM regexp_replace(lower(title), '[^a-z0-9]+', '-', 'g')),
                                                     ''
                                                   ),
                                                   'story'
                                                 ) AS base
                                            FROM content."story"
                                           WHERE "slug" IS NULL
                                         ) AS slugged
                                 ) AS numbered
                         ) AS candidate
                   WHERE s.id = candidate.id
                     AND s."slug" IS NULL`,
          },
        ],
        postcheck: [],
      }),
      rawSql({
        id: 'data.content.story.backfill-source',
        label: 'Mark existing rows with an ISBN as catalogue imports',
        operationClass: 'data',
        target: {
          id: 'content.story',
          details: { schema: 'content', name: 'story', objectType: 'table' },
        },
        precheck: [],
        execute: [
          {
            description: 'Set source = CATALOGUE where an ISBN is present',
            // The seed script (`scripts/seed-books.ts`) is the only writer of
            // `isbn`, so this is exactly the set of imported editions. The
            // column's own default -- SCRIBE -- is right for everything else.
            sql: `UPDATE content."story"
                     SET "source" = 'CATALOGUE'
                   WHERE "isbn" IS NOT NULL`,
          },
        ],
        postcheck: [],
      }),
      rawSql({
        id: 'data.content.story.backfill-listed-at',
        label: 'Treat every pre-existing story as listed',
        operationClass: 'data',
        target: {
          id: 'content.story',
          details: { schema: 'content', name: 'story', objectType: 'table' },
        },
        precheck: [],
        execute: [
          {
            description: 'Set listedAt = createdAt for rows that predate the column',
            // Everything that existed before this migration was reachable, so
            // leaving `listedAt` null would retroactively unpublish the whole
            // catalogue. Only stories authored after this point start as drafts.
            sql: `UPDATE content."story"
                     SET "listedAt" = "createdAt"
                   WHERE "listedAt" IS NULL`,
          },
        ],
        postcheck: [],
      }),
      this.setNotNull({ schema: 'content', table: 'story', column: 'slug' }),
      this.addCheckConstraint({
        schema: 'content',
        table: 'story',
        constraint: 'story_source_check_9abb51b8',
        expression: "\"source\" IN ('SCRIBE', 'CATALOGUE')",
      }),
      this.addUnique({
        schema: 'content',
        table: 'story',
        constraint: 'story_slug_key',
        columns: ['slug'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
