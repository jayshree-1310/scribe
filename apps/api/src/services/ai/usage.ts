/**
 * Where AI usage records go.
 *
 * Logging is deliberately the only sink today: a table nobody reads is worse
 * than a log line, and Task AI 18 is where per-user budgets and spend
 * reporting justify persisting these. Swapping the sink is one call to
 * `setAiUsageSink` -- no feature changes.
 *
 * What is *not* recorded, ever: prompts, completions, or any part of either.
 * A prompt can contain a person's unpublished chapter and a completion can
 * contain their private question, and log streams outlive the requests that
 * wrote them.
 */

import { logger } from "../../lib/logger.js";
import type { AiUsageRecord, AiUsageSink } from "./types.js";

const logSink: AiUsageSink = (record) => {
  const line = { ai: record };

  if (record.outcome === "error") logger.warn(line, "AI call failed");
  else logger.info(line, "AI call");
};

let sink: AiUsageSink = logSink;

export function setAiUsageSink(next: AiUsageSink | null): void {
  sink = next ?? logSink;
}

export function logAiUsage(record: AiUsageRecord): void {
  // A failure to record must never fail the request that generated it.
  try {
    sink(record);
  } catch (error) {
    logger.warn({ err: error }, "AI usage sink threw");
  }
}
