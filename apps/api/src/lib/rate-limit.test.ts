/**
 * `reserveAttempt` against the development Redis: the property that matters
 * is that concurrent requests cannot all pass, which only a real server with
 * real concurrency can show.
 */

import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { databaseAvailable } from "../test/harness.js";
import { connectRedis, redis } from "./redis.js";
import { reserveAttempt } from "./rate-limit.js";

const available = await databaseAvailable();
const keys: string[] = [];

function freshKey(): string {
  const key = `test:ratelimit:${randomUUID()}`;
  keys.push(key);
  return key;
}

afterAll(async () => {
  if (!available) return;
  await connectRedis();
  for (const key of keys) await redis.del(key);
});

describe.skipIf(!available)("reserveAttempt", () => {
  it("lets exactly the limit through when twenty arrive at once", async () => {
    const key = freshKey();

    const results = await Promise.all(
      Array.from({ length: 20 }, () => reserveAttempt(key, 5, 60)),
    );

    expect(results.filter((result) => !result.limited)).toHaveLength(5);
    // A refused attempt is given back, so the counter is the limit, not twenty.
    expect(Number(await redis.get(key))).toBe(5);
  });

  it("gives an attempt back when the work it paid for fails", async () => {
    const key = freshKey();

    const attempt = await reserveAttempt(key, 1, 60);
    await expect(
      Promise.reject(new Error("no such story")).catch(attempt.refundAndRethrow),
    ).rejects.toThrow("no such story");

    // The refund freed the one slot.
    expect((await reserveAttempt(key, 1, 60)).limited).toBe(false);
    expect((await reserveAttempt(key, 1, 60)).limited).toBe(true);
  });

  it("opens a window with a TTL", async () => {
    const key = freshKey();

    await reserveAttempt(key, 3, 60);
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });
});
