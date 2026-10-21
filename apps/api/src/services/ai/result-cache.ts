/**
 * Results reused by what they were generated from (Task AI 18).
 *
 * Recaps, story-bible readings, continuity checks and embeddings already
 * store their output keyed on a hash of their input. This is the same idea
 * for calls whose output is not worth a table: the key is a hash of
 * *everything* the reply depends on -- the prompt id and version, the model,
 * and the input text -- so a hit is the reply that request would have got,
 * and any change to any of them is a miss rather than a stale answer.
 *
 * Only for deterministic-enough calls whose input is the whole story: a
 * reply that depends on who is asking, or on rows that change underneath it,
 * does not belong here. And only text: a hit is served without a provider
 * call, so it costs nothing and is charged nothing.
 *
 * Redis, best effort. A cache that is down is a slower request, never a
 * failed one.
 */

import { createHash } from "node:crypto";
import { logger } from "../../lib/logger.js";
import { connectRedis, redis } from "../../lib/redis.js";
import { loadAiConfig } from "./config.js";

export function resultKey(parts: readonly unknown[]): string {
  return `ai:result:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

export async function readResult(key: string): Promise<string | null> {
  if (loadAiConfig().resultCacheSeconds <= 0) return null;
  try {
    await connectRedis();
    return await redis.get(key);
  } catch (error) {
    logger.warn({ err: error }, "AI result cache unavailable");
    return null;
  }
}

export async function storeResult(key: string, text: string): Promise<void> {
  const seconds = loadAiConfig().resultCacheSeconds;
  // An empty reply is a failure that happened to parse, not an answer.
  if (seconds <= 0 || text.trim() === "") return;
  try {
    await connectRedis();
    await redis.set(key, text, { EX: seconds });
  } catch (error) {
    logger.warn({ err: error }, "AI result not cached");
  }
}
