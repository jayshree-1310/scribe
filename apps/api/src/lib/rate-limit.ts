import { connectRedis, redis } from "./redis.js";

type RateLimitStatus = {
  limited: boolean;
  /** Seconds until the window resets, for a `Retry-After` header. */
  retryAfter: number;
};

/**
 * Reads a counter without touching it, so asking "is this caller over budget?"
 * is not itself an attempt.
 */
export async function isRateLimited(
  key: string,
  limit: number,
): Promise<RateLimitStatus> {
  // `server.ts` connects on boot, but anything that starts the app without it
  // — the integration harness, a script — would otherwise fail every limited
  // route with a 500. Connecting here is idempotent.
  await connectRedis();

  const replies = await redis.multi().get(key).ttl(key).exec();

  const count = Number(replies[0] ?? 0);
  const ttl = Number(replies[1]);

  return {
    limited: count >= limit,
    retryAfter: ttl > 0 ? ttl : 0,
  };
}

/**
 * Counts one attempt against the caller, opening the window if this is the
 * first.
 *
 * INCR and EXPIRE ship as one transaction, and `NX` sets a TTL only when the
 * key has none. Done as a separate `if (count === 1) await expire(...)`, a
 * process dying — or the second command failing — between the two leaves a
 * counter with no expiry, which never resets and locks that caller out for
 * good. `NX` also lets a later attempt heal such a key rather than inherit it.
 */
export async function recordAttempt(
  key: string,
  windowSeconds: number,
): Promise<void> {
  await connectRedis();

  await redis.multi().incr(key).expire(key, windowSeconds, "NX").exec();
}

export type Reservation = RateLimitStatus & {
  /** Gives the attempt back: for a request that failed and should not count. */
  refund: () => Promise<void>;
  /** `refund`, then rethrows: `await work().catch(attempt.refundAndRethrow)`. */
  refundAndRethrow: (error: unknown) => Promise<never>;
};

/**
 * Counts an attempt and decides in the same step, so concurrent requests
 * cannot all pass.
 *
 * `isRateLimited` then `recordAttempt` is check-then-act: twenty requests sent
 * at once all read the counter before any of them writes it, and all twenty
 * get through a limit of five. Here the increment comes first and its result
 * is the decision -- the sixth request sees 6. An attempt over the limit is
 * given back at once, so being refused does not extend the lock-out.
 *
 * Routes that charge only for work that succeeded (a comment that landed, not
 * one refused for a missing story) call `refund` when the work throws.
 */
export async function reserveAttempt(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<Reservation> {
  await connectRedis();

  const replies = await redis
    .multi()
    .incr(key)
    .expire(key, windowSeconds, "NX")
    .ttl(key)
    .exec();

  const count = Number(replies[0]);
  const ttl = Number(replies[2]);
  const refund = async () => {
    await redis.decr(key);
  };

  const refundAndRethrow = async (error: unknown): Promise<never> => {
    await refund();
    throw error;
  };

  if (count > limit) {
    await refund();
    return {
      limited: true,
      retryAfter: ttl > 0 ? ttl : 0,
      refund: async () => {},
      refundAndRethrow: async (error) => {
        throw error;
      },
    };
  }

  return { limited: false, retryAfter: 0, refund, refundAndRethrow };
}
