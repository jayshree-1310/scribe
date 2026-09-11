/**
 * Refresh-token sessions: how they are stored, issued, rotated and revoked.
 *
 * Extracted from `routes/auth.ts` because sign-in is no longer the only thing
 * that has to end a session. A password change, a password reset and account
 * deletion all have to revoke sessions, and each reimplementing "delete the
 * token, the family and the index entry" is three chances to forget one of the
 * three keys and leave a credential alive.
 */

import type { Request, Response } from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { HttpError } from "./http-error.js";
import { createAccessToken, createRefreshToken } from "./jwt.js";
import { redis } from "./redis.js";

export const REFRESH_TOKEN_COOKIE = "refreshToken";

/** How long one refresh token is good for. Rotation issues a fresh window. */
export const REFRESH_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * A ceiling on the whole chain, which rotation cannot extend. Without it, a
 * token that keeps being refreshed is a permanent credential, and a thief who
 * refreshes quietly never has to re-authenticate.
 */
export const ABSOLUTE_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Concurrent sessions kept per user; the oldest is evicted beyond this. */
const MAX_SESSIONS_PER_USER = 10;

const refreshCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/api/auth",
};

/* Session storage ------------------------------------------------------- */

/**
 * Three keys describe a session:
 *
 * - `auth:refresh:<sid>`      the live token, one per rotation step
 * - `auth:family:<fid>`       the chain's current sid, outliving each step
 * - `auth:sessions:<userId>`  every live sid for a user, scored by creation
 *
 * The family key is what makes replay detectable. Rotation deletes the old
 * sid, so a replayed token finds nothing — indistinguishable from an expired
 * session unless something remembers the chain. If the family is still alive
 * when a token's own sid is gone, that token was already rotated, which means
 * two parties hold tokens from one chain and the whole chain is burnt.
 */
export function sessionKey(sessionId: string): string {
  return `auth:refresh:${sessionId}`;
}

export function familyKey(familyId: string): string {
  return `auth:family:${familyId}`;
}

export function userSessionsKey(userId: string): string {
  return `auth:sessions:${userId}`;
}

export interface SessionRecord {
  userId: string;
  familyId: string;
  refreshTokenHash: string;
  /** Epoch ms after which no rotation may extend this chain. */
  absoluteExpiresAt: number;
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Constant-time comparison. Both sides are digests rather than secrets, so a
 * leak here is not directly exploitable, but comparing them with `===` returns
 * sooner the earlier they differ, which is free information.
 */
export function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");

  return left.length === right.length && timingSafeEqual(left, right);
}

export function parseSession(raw: string): SessionRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SessionRecord>;

    if (
      typeof parsed.userId !== "string" ||
      typeof parsed.familyId !== "string" ||
      typeof parsed.refreshTokenHash !== "string" ||
      typeof parsed.absoluteExpiresAt !== "number"
    ) {
      return null;
    }

    return parsed as SessionRecord;
  } catch {
    return null;
  }
}

/** Removes one session and forgets its chain. */
export async function revokeSession(
  sessionId: string,
  session: Pick<SessionRecord, "userId" | "familyId">,
): Promise<void> {
  await redis
    .multi()
    .del(sessionKey(sessionId))
    .del(familyKey(session.familyId))
    .zRem(userSessionsKey(session.userId), sessionId)
    .exec();
}

/**
 * Burns an entire chain after a replay. The holder of the live token loses it
 * too — that is the point: one of the two parties is an attacker and we cannot
 * tell which, so both re-authenticate.
 */
export async function revokeFamily(familyId: string): Promise<void> {
  const liveSessionId = await redis.get(familyKey(familyId));

  if (!liveSessionId) {
    await redis.del(familyKey(familyId));
    return;
  }

  const raw = await redis.get(sessionKey(liveSessionId));
  const session = raw ? parseSession(raw) : null;

  const pipeline = redis
    .multi()
    .del(sessionKey(liveSessionId))
    .del(familyKey(familyId));

  if (session) {
    pipeline.zRem(userSessionsKey(session.userId), liveSessionId);
  }

  await pipeline.exec();
}

/**
 * Revokes every session a user has.
 *
 * "Sign out everywhere" is the obvious caller, but the important ones are the
 * credential changes: after a password change or reset, a session opened with
 * the old password must not survive, or changing a password after a breach
 * achieves nothing.
 */
export async function revokeAllSessions(userId: string): Promise<number> {
  const sessionIds = await redis.zRange(userSessionsKey(userId), 0, -1);

  if (sessionIds.length === 0) {
    await redis.del(userSessionsKey(userId));
    return 0;
  }

  const records = await Promise.all(
    sessionIds.map(async (id) => {
      const raw = await redis.get(sessionKey(id));
      return raw ? parseSession(raw) : null;
    }),
  );

  const pipeline = redis.multi();

  for (const id of sessionIds) {
    pipeline.del(sessionKey(id));
  }

  for (const record of records) {
    if (record) pipeline.del(familyKey(record.familyId));
  }

  pipeline.del(userSessionsKey(userId));

  await pipeline.exec();

  return sessionIds.length;
}

/**
 * Writes a session, points its family at it, indexes it under the user, and
 * trims the user back to `MAX_SESSIONS_PER_USER` by evicting the oldest.
 *
 * Returns the cookie lifetime, which is the session TTL rather than a fixed
 * seven days: near the absolute ceiling the remaining window is shorter, and a
 * cookie outliving its session only produces confusing 401s.
 */
export async function storeSession(
  sessionId: string,
  session: SessionRecord,
): Promise<number> {
  const secondsLeft = Math.floor(
    (session.absoluteExpiresAt - Date.now()) / 1000,
  );

  const ttl = Math.min(REFRESH_SESSION_TTL_SECONDS, secondsLeft);

  if (ttl <= 0) {
    return 0;
  }

  await redis
    .multi()
    .set(sessionKey(sessionId), JSON.stringify(session), { EX: ttl })
    // The family must outlive the individual token, or a replay arriving after
    // the token expired would look like an ordinary expiry.
    .set(familyKey(session.familyId), sessionId, { EX: secondsLeft })
    .zAdd(userSessionsKey(session.userId), {
      score: Date.now(),
      value: sessionId,
    })
    .expire(userSessionsKey(session.userId), ABSOLUTE_SESSION_TTL_SECONDS)
    .exec();

  const excess = await redis.zRange(
    userSessionsKey(session.userId),
    0,
    -(MAX_SESSIONS_PER_USER + 1),
  );

  if (excess.length > 0) {
    const stale = await Promise.all(
      excess.map(async (id) => {
        const raw = await redis.get(sessionKey(id));
        return { id, record: raw ? parseSession(raw) : null };
      }),
    );

    const pipeline = redis.multi();

    for (const { id, record } of stale) {
      pipeline.del(sessionKey(id));
      if (record) pipeline.del(familyKey(record.familyId));
    }

    pipeline.zRem(userSessionsKey(session.userId), excess);

    await pipeline.exec();
  }

  return ttl;
}

/* Cookie ---------------------------------------------------------------- */

export function readRefreshCookie(req: Request): string | null {
  const cookieHeader = req.headers.cookie;

  if (!cookieHeader) {
    return null;
  }

  for (const cookie of cookieHeader.split(";")) {
    const [name, ...valueParts] = cookie.trim().split("=");

    if (name === REFRESH_TOKEN_COOKIE) {
      try {
        return decodeURIComponent(valueParts.join("="));
      } catch {
        // Malformed percent-encoding: treat as no cookie, not a server error.
        return null;
      }
    }
  }

  return null;
}

export function setRefreshCookie(res: Response, token: string, ttl: number): void {
  res.cookie(REFRESH_TOKEN_COOKIE, token, {
    ...refreshCookieOptions,
    maxAge: ttl * 1000,
  });
}

/**
 * Clears the cookie. The `path` in the options is what makes this work from
 * outside `/api/auth` — account deletion answers from `/api/account`, and a
 * `Set-Cookie` names the path it clears rather than inheriting the request's.
 */
export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_TOKEN_COOKIE, refreshCookieOptions);
}

/**
 * Issues a session and its tokens. Shared by login, rotation and the password
 * routes so none of them can disagree about how a session is built.
 */
export async function issueSession(
  res: Response,
  userId: string,
  familyId: string,
  absoluteExpiresAt: number,
): Promise<string> {
  const sessionId = randomBytes(32).toString("hex");
  const refreshToken = createRefreshToken(userId, sessionId, familyId);

  const ttl = await storeSession(sessionId, {
    userId,
    familyId,
    refreshTokenHash: hashRefreshToken(refreshToken),
    absoluteExpiresAt,
  });

  if (ttl <= 0) {
    throw HttpError.unauthorized("Your session has expired. Please sign in.");
  }

  setRefreshCookie(res, refreshToken, ttl);

  return createAccessToken(userId);
}

/**
 * Starts a brand-new chain for a user who has just proven who they are.
 * Login, Google sign-in and a password change all want exactly this.
 */
export function startSession(res: Response, userId: string): Promise<string> {
  return issueSession(
    res,
    userId,
    randomBytes(32).toString("hex"),
    Date.now() + ABSOLUTE_SESSION_TTL_SECONDS * 1000,
  );
}
