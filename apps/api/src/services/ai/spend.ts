/**
 * AI spend, read back from `ai.UsageEvent` for administrators (Task AI 18).
 *
 * By feature first, because that is the question asked when a bill moves:
 * not "how many calls" but "which feature, and is it the one we just
 * changed". By model, because routing a feature to a cheaper model is the
 * lever. And the heaviest callers, because a loop is a person.
 *
 * Dollars only when `AI_INPUT_USD_PER_MTOK` and `AI_OUTPUT_USD_PER_MTOK` are
 * set to the provider's published prices; there is no built-in price table,
 * because a stale one would be a confident wrong number. Cached input tokens
 * are reported but not discounted, for the same reason -- providers price
 * them differently and say so on their own pages.
 */

import { db } from "../../prisma/db.js";
import { loadAiConfig } from "./config.js";

export const SPEND_WINDOWS = [1, 7, 30] as const;
export type SpendWindow = (typeof SPEND_WINDOWS)[number];

export interface SpendLine {
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  avgDurationMs: number;
  /** Null when no prices are configured. */
  costUsd: number | null;
}

export interface SpendReport {
  days: SpendWindow;
  priced: boolean;
  total: SpendLine;
  byFeature: (SpendLine & { feature: string; kind: string })[];
  byModel: (SpendLine & { model: string; provider: string })[];
  /** Heaviest first. `username` is null for an account that no longer exists. */
  topCallers: (SpendLine & { userId: string; username: string | null })[];
  /** The platform's own work: moderation, scripts, the eval. */
  platform: SpendLine;
}

interface Row {
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  avgDurationMs: number;
}

interface GroupedRow extends Row {
  byFeature: number;
  byModel: number;
  byUser: number;
  feature: string | null;
  kind: string | null;
  model: string | null;
  provider: string | null;
  userId: string | null;
  username: string | null;
}

const text = { codecId: "pg/text@1", nullable: true } as const;

function line(row: Row | undefined): SpendLine {
  const pricing = loadAiConfig().pricing;
  const base: Row = row
    ? {
        calls: row.calls,
        errors: row.errors,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cachedTokens: row.cachedTokens,
        avgDurationMs: row.avgDurationMs,
      }
    : { calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, avgDurationMs: 0 };
  return {
    ...base,
    costUsd: pricing
      ? (base.inputTokens * pricing.inputPerMTok + base.outputTokens * pricing.outputPerMTok) / 1_000_000
      : null,
  };
}

const tokensOf = (row: Row) => row.inputTokens + row.outputTokens;

/**
 * One scan, four groupings: the window's total, and by feature, by model and
 * by caller. `GROUPING()` says which grouping a row belongs to -- a null
 * `userId` is otherwise ambiguous between "grouped by user, and it was the
 * platform" and "not grouped by user at all".
 */
export async function spendReport(days: SpendWindow): Promise<SpendReport> {
  const rows = (await db.runtime().query(
    db.raw.sql`
      SELECT GROUPING(e."feature")::int                          AS "byFeature",
             GROUPING(e."model")::int                            AS "byModel",
             GROUPING(e."userId")::int                           AS "byUser",
             e."feature"                                         AS "feature",
             e."kind"                                            AS "kind",
             e."model"                                           AS "model",
             e."provider"                                        AS "provider",
             e."userId"                                          AS "userId",
             MAX(u."username")                                   AS "username",
             COUNT(*)::int                                       AS "calls",
             COUNT(*) FILTER (WHERE e."outcome" = 'error')::int  AS "errors",
             COALESCE(SUM(e."inputTokens"), 0)::int              AS "inputTokens",
             COALESCE(SUM(e."outputTokens"), 0)::int             AS "outputTokens",
             COALESCE(SUM(e."cachedTokens"), 0)::int             AS "cachedTokens",
             COALESCE(ROUND(AVG(e."durationMs")), 0)::int        AS "avgDurationMs"
        FROM "ai"."usageEvent" AS e
        LEFT JOIN "auth"."user" AS u ON u."id" = e."userId"
       WHERE e."createdAt" >= now() - (${days}::int * interval '1 day')
       GROUP BY GROUPING SETS ((), (e."feature", e."kind"), (e."model", e."provider"), (e."userId"))
    `
      .returnsRow({
        byFeature: "pg/int4@1",
        byModel: "pg/int4@1",
        byUser: "pg/int4@1",
        feature: text,
        kind: text,
        model: text,
        provider: text,
        userId: text,
        username: text,
        calls: "pg/int4@1",
        errors: "pg/int4@1",
        inputTokens: "pg/int4@1",
        outputTokens: "pg/int4@1",
        cachedTokens: "pg/int4@1",
        avgDurationMs: "pg/int4@1",
      })
      .build(),
  )) as GroupedRow[];

  const heaviest = <T extends Row>(list: T[]) => [...list].sort((a, b) => tokensOf(b) - tokensOf(a));
  const total = rows.find((row) => row.byFeature === 1 && row.byModel === 1 && row.byUser === 1);
  const users = rows.filter((row) => row.byUser === 0);

  return {
    days,
    priced: loadAiConfig().pricing !== null,
    total: line(total),
    platform: line(users.find((row) => row.userId === null)),
    byFeature: heaviest(rows.filter((row) => row.byFeature === 0)).map((row) => ({
      ...line(row),
      feature: row.feature ?? "",
      kind: row.kind ?? "",
    })),
    byModel: heaviest(rows.filter((row) => row.byModel === 0)).map((row) => ({
      ...line(row),
      model: row.model ?? "",
      provider: row.provider ?? "",
    })),
    topCallers: heaviest(users.filter((row) => row.userId !== null))
      .slice(0, 10)
      .map((row) => ({ ...line(row), userId: row.userId as string, username: row.username })),
  };
}
