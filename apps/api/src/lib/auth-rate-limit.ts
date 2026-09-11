/**
 * Per-caller budgets for the authentication routes.
 *
 * Extracted from `routes/auth.ts` so the password-reset and verification
 * routes throttle the same way rather than each inventing a key format — two
 * formats in one keyspace is how a limiter ends up counting something other
 * than what it thinks it is counting.
 */

import type { Request } from "express";
import { createHash } from "node:crypto";
import { HttpError } from "./http-error.js";
import { isRateLimited, recordAttempt } from "./rate-limit.js";

export const RATE_LIMIT_WINDOW_SECONDS = 15 * 60;

export type RateLimitScope =
  | "signup"
  | "login"
  | "refresh"
  | "logout"
  | "google"
  | "forgot"
  | "reset"
  | "password"
  | "verify";

/**
 * `req.ip` reports IPv4 callers as IPv4-mapped IPv6 (`::ffff:127.0.0.1`) on a
 * dual-stack listener, so one client would otherwise get a counter per
 * protocol and twice the allowance just by switching.
 */
export function clientIp(req: Request): string {
  const ip = req.ip || req.socket.remoteAddress || "unknown";

  return ip.startsWith("::ffff:") ? ip.slice("::ffff:".length) : ip;
}

/**
 * Namespaced away from `auth:refresh:<sessionId>`: with counters at
 * `auth:<scope>:<subject>`, the refresh limiter's key was `auth:refresh:<ip>`,
 * sitting inside the session keyspace. Nothing can forge a session id that
 * looks like an IP, but anything scanning `auth:refresh:*` would have counted
 * limiters as sessions.
 */
function rateLimitKey(scope: RateLimitScope, subject: string): string {
  return `auth:ratelimit:${scope}:${subject}`;
}

/**
 * Throws 429 when the caller is out of budget. This only reads the counter;
 * routes record attempts themselves, which is what lets login charge for
 * failures alone. Charging every request would spend a shared office IP's
 * allowance on people signing in successfully, and refunding on success would
 * let anyone holding one valid account clear the counter and buy ten fresh
 * guesses at everyone else's.
 */
export async function assertWithinLimit(
  scope: RateLimitScope,
  subject: string,
  limit: number,
): Promise<void> {
  const { limited, retryAfter } = await isRateLimited(
    rateLimitKey(scope, subject),
    limit,
  );

  if (limited) {
    throw HttpError.tooManyRequests(
      `Too many ${scope} attempts. Please try again later.`,
      retryAfter || RATE_LIMIT_WINDOW_SECONDS,
    );
  }
}

export function chargeLimit(
  scope: RateLimitScope,
  subject: string,
): Promise<void> {
  return recordAttempt(rateLimitKey(scope, subject), RATE_LIMIT_WINDOW_SECONDS);
}

/** The common case: one budget per calling address. */
export function assertWithinRateLimit(
  req: Request,
  scope: RateLimitScope,
  limit: number,
): Promise<void> {
  return assertWithinLimit(scope, clientIp(req), limit);
}

export function chargeRateLimit(
  req: Request,
  scope: RateLimitScope,
): Promise<void> {
  return chargeLimit(scope, clientIp(req));
}

/**
 * A subject for a limit keyed by email address.
 *
 * Hashed rather than stored plainly: forgot-password is reachable without an
 * account, so the keyspace would otherwise accumulate a browsable list of
 * every address anyone has ever typed into the form.
 */
export function emailSubject(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}
