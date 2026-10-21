/**
 * Whether the model provider and the embedder are answering (Task AI 20).
 *
 * Read by `/health`, which must not *fail* when AI is down: a load balancer
 * that pulls an instance out of rotation because the model is unreachable
 * takes the whole app down for a dependency every page works without. So this
 * reports a *degraded* signal beside an `ok` status, and it costs nothing to
 * read -- it is fed by every usage record (`usage.ts`) rather than by probing
 * the provider on each health check, which would be a paid call every few
 * seconds.
 *
 * Degraded means the most recent call of that kind, within the window,
 * failed for a reason that is the provider's (unreachable, timed out,
 * refused, rate-limited, unusable reply) -- not the caller's.
 */

import type { AiUsageRecord } from "./types.js";

export type AiHealthState = "ok" | "degraded" | "unknown";

/** Older than this, the last outcome says nothing about now. */
const WINDOW_MS = 5 * 60_000;

const PROVIDER_FAULTS = new Set([
  "service_unavailable",
  "upstream_error",
  "too_many_requests",
  "internal_error",
]);

interface Last {
  ok: boolean;
  at: number;
  code: string | null;
}

const last: Record<"chat" | "embed", Last | null> = { chat: null, embed: null };

export function recordOutcome(record: Pick<AiUsageRecord, "kind" | "outcome" | "errorCode">): void {
  const fault = record.outcome === "error" && PROVIDER_FAULTS.has(record.errorCode ?? "internal_error");
  // A caller's own error (a refused budget, say) says nothing about the provider.
  if (record.outcome === "error" && !fault) return;
  last[record.kind] = { ok: record.outcome === "ok", at: Date.now(), code: record.errorCode ?? null };
}

function stateOf(entry: Last | null): { state: AiHealthState; lastError?: string } {
  if (!entry || Date.now() - entry.at > WINDOW_MS) return { state: "unknown" };
  return entry.ok ? { state: "ok" } : { state: "degraded", lastError: entry.code ?? "internal_error" };
}

export function aiHealth(): { chat: ReturnType<typeof stateOf>; embed: ReturnType<typeof stateOf> } {
  return { chat: stateOf(last.chat), embed: stateOf(last.embed) };
}

/** Test seam. */
export function resetAiHealth(): void {
  last.chat = null;
  last.embed = null;
}
