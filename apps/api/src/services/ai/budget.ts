/**
 * The per-user token budget `config.ts` has always read and nothing enforced.
 *
 * A request limit and a token budget answer different questions. Twenty
 * requests is twenty requests whether each one was a sentence or a chapter,
 * so `lib/rate-limit.ts` caps how *often* somebody can ask and this caps how
 * much they can spend doing it. Both are needed: the first stops a loop, the
 * second stops one caller quietly consuming the machine for an afternoon.
 *
 * It is not a second limiter. The read side *is* `isRateLimited` -- a counter
 * compared against a ceiling, with the window's TTL as the retry hint -- and
 * the only thing written here is the increment, because tokens arrive tens of
 * thousands at a time rather than one per attempt.
 *
 * Two honest limitations, both inherent rather than shortcuts:
 *
 * - **The count is behind by one call.** What a completion costs is not known
 *   until it has been generated, so a caller just under the ceiling can cross
 *   it by one request's worth. The ceiling is a budget, not a hard stop.
 * - **It lives in Redis, so it is per-window rather than per-day and it is not
 *   auditable.** Persisted usage, spend by feature and an admin view are Task
 *   AI 18; this is the check that makes `AI_DAILY_TOKEN_BUDGET` mean
 *   something in the meantime.
 */

import { HttpError } from "../../lib/http-error.js";
import { logger } from "../../lib/logger.js";
import { isRateLimited } from "../../lib/rate-limit.js";
import { connectRedis, redis } from "../../lib/redis.js";
import { loadAiConfig } from "./config.js";

/**
 * A rolling day opened by the caller's first spend, not a calendar day.
 *
 * Same shape as every other window in the codebase, and it avoids the
 * midnight-UTC cliff where a budget resets at lunchtime for half the world.
 */
const WINDOW_SECONDS = 60 * 60 * 24;

/** Exported so a test can clear a counter that outlives the test run. */
export function dailyBudgetKey(userId: string): string {
  return `ai:tokens:${userId}`;
}

/**
 * Refuses a caller who has spent their budget, before a single token is spent.
 *
 * 429 rather than 402 or 403: the caller is not forbidden and has not paid for
 * anything -- they have asked for too much too fast, which is what 429 means,
 * and `Retry-After` tells them exactly how long the window has left.
 */
export async function assertWithinDailyBudget(userId: string): Promise<void> {
  const { dailyTokenBudget } = loadAiConfig();
  if (dailyTokenBudget <= 0) return;

  const status = await isRateLimited(dailyBudgetKey(userId), dailyTokenBudget);
  if (!status.limited) return;

  throw HttpError.tooManyRequests(
    "You have used today's AI allowance. It resets within a day.",
    // A counter with no TTL would report 0 and promise an immediate retry that
    // would fail; the full window is the honest answer to "how long".
    status.retryAfter > 0 ? status.retryAfter : WINDOW_SECONDS,
  );
}

/**
 * Charges a completed call against the caller's window.
 *
 * Never throws. This runs *after* the model has answered, and a Redis blip
 * must not turn a reply the user is waiting for into a 500 -- losing the
 * accounting for one call is cheaper than losing the call.
 */
export async function recordTokenUsage(
  userId: string,
  tokens: number,
): Promise<void> {
  const { dailyTokenBudget } = loadAiConfig();
  if (dailyTokenBudget <= 0 || tokens <= 0) return;

  const key = dailyBudgetKey(userId);

  try {
    await connectRedis();
    // INCRBY and EXPIRE as one transaction, with `NX` so a later call cannot
    // push the window's end further away -- see `recordAttempt`, which this
    // mirrors deliberately.
    await redis
      .multi()
      .incrBy(key, tokens)
      .expire(key, WINDOW_SECONDS, "NX")
      .exec();
  } catch (error) {
    logger.warn({ err: error }, "AI token budget not recorded");
  }
}
