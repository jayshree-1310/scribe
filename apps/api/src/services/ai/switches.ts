/**
 * Turning an AI feature off without a deploy (Task AI 20).
 *
 * An environment variable needs a restart and, on most hosts, a deploy. When a
 * feature is misbehaving -- a prompt producing something it should not, a
 * provider bill climbing -- the useful lever is one an operator can pull in a
 * second and push back as fast. So the switches live in Redis: a set of
 * feature prefixes that are off, read by `withPolicy` before every model call.
 *
 * A prefix, like `AI_FEATURE_MODELS`: `assist` turns off all eight assistant
 * actions, `assist.continue` only one. A switched-off feature answers 503 with
 * a message saying so, which every AI panel already renders as "unavailable".
 *
 * Read through a ten-second in-memory cache, so the check costs a Redis
 * round trip per instance per ten seconds rather than per call; turning a
 * feature off takes effect within that.
 */

import { HttpError } from "../../lib/http-error.js";
import { logger } from "../../lib/logger.js";
import { connectRedis, redis } from "../../lib/redis.js";

const KEY = "ai:switches:off";
const CACHE_MS = 10_000;

let cache: { at: number; off: string[] } | null = null;

export async function disabledFeatures(): Promise<string[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.off;
  try {
    await connectRedis();
    const off = (await redis.sMembers(KEY)).sort();
    cache = { at: Date.now(), off };
    return off;
  } catch (error) {
    // Redis away: fail open. A kill switch that took every feature down with
    // Redis would be a second outage caused by the first.
    logger.warn({ err: error }, "AI switches unreadable; assuming all on");
    return cache?.off ?? [];
  }
}

export function isOff(feature: string, off: readonly string[]): boolean {
  return off.some((prefix) => feature === prefix || feature.startsWith(`${prefix}.`));
}

export async function assertFeatureOn(feature: string): Promise<void> {
  if (isOff(feature, await disabledFeatures())) {
    throw HttpError.unavailable("This AI feature is switched off for now. Everything else still works.");
  }
}

export async function setFeature(prefix: string, enabled: boolean): Promise<string[]> {
  await connectRedis();
  if (enabled) await redis.sRem(KEY, prefix);
  else await redis.sAdd(KEY, prefix);
  cache = null;
  return disabledFeatures();
}

/** Test seam: forget the cached read. */
export function resetSwitchCache(): void {
  cache = null;
}
