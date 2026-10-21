/**
 * Where AI usage records go: the log, and `ai.UsageEvent` (Task AI 18).
 *
 * Every call through the provider seam lands here once -- success or failure,
 * chat or embedding -- from the wrappers in `provider.ts`. The record names
 * the feature, the model, the token counts the provider reported (cached
 * input tokens included, when it reports them), the duration and the outcome,
 * and the caller it ran as, from `caller.ts`.
 *
 * What is *not* recorded, ever: prompts, completions, or any part of either.
 * A prompt can contain a person's unpublished chapter and a completion can
 * contain their private question, and log streams and tables outlive the
 * requests that wrote them.
 *
 * The row is written fire-and-forget: a failure to record must never fail,
 * or slow, the request that generated it. `flushUsage` settles pending writes
 * for shutdown, account deletion and the tests; it is in the second band of
 * `drainDeferredWrites`, because moderation -- in the first -- calls the model.
 * `AI_USAGE_PERSIST=off` keeps the log line and skips the row; the test
 * suite runs that way, and the suites that assert on rows turn it on.
 */

import { logger } from "../../lib/logger.js";
import { db } from "../../prisma/db.js";
import { currentRequestId, currentUserId } from "./caller.js";
import { recordOutcome } from "./health.js";
import { loadAiConfig } from "./config.js";
import type { AiUsageRecord, AiUsageSink } from "./types.js";

const pending = new Set<Promise<void>>();

function persist(record: AiUsageRecord): void {
  if (!loadAiConfig().usagePersist) return;

  const write = db.orm.ai.UsageEvent.create({
    userId: record.userId ?? null,
    feature: record.feature.slice(0, 120),
    kind: record.kind,
    provider: record.provider,
    model: record.model.slice(0, 200),
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cachedTokens: record.cachedInputTokens ?? 0,
    durationMs: Math.round(record.durationMs),
    outcome: record.outcome,
    errorCode: record.errorCode ?? null,
  })
    .then(() => undefined)
    .catch((error: unknown) => {
      logger.warn({ err: error }, "AI usage row not written");
    })
    .finally(() => {
      pending.delete(write);
    });

  pending.add(write);
}

const defaultSink: AiUsageSink = (record) => {
  const line = { ai: record };

  if (record.outcome === "error") logger.warn(line, "AI call failed");
  else logger.info(line, "AI call");

  persist(record);
};

let sink: AiUsageSink = defaultSink;

export function setAiUsageSink(next: AiUsageSink | null): void {
  sink = next ?? defaultSink;
}

export function logAiUsage(record: AiUsageRecord): void {
  // A failure to record must never fail the request that generated it.
  try {
    recordOutcome(record);
    sink({
      ...record,
      userId: record.userId === undefined ? currentUserId() : record.userId,
      requestId: record.requestId === undefined ? currentRequestId() : record.requestId,
    });
  } catch (error) {
    logger.warn({ err: error }, "AI usage sink threw");
  }
}

/** Settles every usage row issued so far, including ones issued while waiting. */
export async function flushUsage(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}

/**
 * Deletes usage rows older than the retention window, and says how many.
 *
 * Retention is a decision rather than an accident (`docs/ai-security.md`):
 * ninety days is long enough to see a month-on-month trend in the spend view
 * and short enough that a cost record does not become a history of what one
 * person did for a year. Run by `pnpm --filter api ai:prune-usage`; Task AI 20
 * is where it becomes a scheduled job.
 */
export async function pruneUsage(days = loadAiConfig().usageRetentionDays): Promise<number> {
  if (days <= 0) return 0;
  const [row] = (await db.runtime().query(
    db.raw.sql`
      WITH gone AS (
        DELETE FROM "ai"."usageEvent"
         WHERE "createdAt" < now() - (${days}::int * interval '1 day')
         RETURNING 1
      )
      SELECT COUNT(*)::int AS "removed" FROM gone
    `
      .returnsRow({ removed: "pg/int4@1" })
      .build(),
  )) as { removed: number }[];
  return row?.removed ?? 0;
}
