import { type Request, type Response, Router } from "express";
import { z } from "zod";
import argon2 from "argon2";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "../prisma/db.js";
import { HttpError } from "../lib/http-error.js";
import { parseOrThrow } from "../lib/validate.js";
import {
  createAccessToken,
  createRefreshToken,
  verifyRefreshToken,
} from "../lib/jwt.js";
import { verifyGoogleIdToken } from "../lib/google.js";
import { redis } from "../lib/redis.js";
import { isRateLimited, recordAttempt } from "../lib/rate-limit.js";

const router = Router();

/**
 * Matches the rule the sign-up form enforces (`apps/web/src/lib/auth.ts`).
 * The two drifting apart means the form accepts names the API rejects, or
 * worse, the reverse.
 *
 * Stored lower-case: the column is `@unique`, which is case-sensitive, so
 * without normalising here `Alice` and `alice` are two accounts that look like
 * one — a ready-made impersonation.
 */
const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(24)
  .regex(
    /^[a-z0-9_]+$/,
    "Use only letters, numbers and underscores.",
  );

const emailSchema = z.string().trim().toLowerCase().email();

const passwordSchema = z.string().min(8).max(128);

const signupSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
});

const loginSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,p=4,t=3$xNteWUCFVchT8WWZ+0XcgQ$J2wuSEHpgb09Rthx8cxqCsoxyOP821vImY7a8Knaqf4";

const REFRESH_TOKEN_COOKIE = "refreshToken";

const RATE_LIMIT_WINDOW_SECONDS = 15 * 60;

/** How long one refresh token is good for. Rotation issues a fresh window. */
const REFRESH_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * A ceiling on the whole chain, which rotation cannot extend. Without it, a
 * token that keeps being refreshed is a permanent credential, and a thief who
 * refreshes quietly never has to re-authenticate.
 */
const ABSOLUTE_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

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
function sessionKey(sessionId: string): string {
  return `auth:refresh:${sessionId}`;
}

function familyKey(familyId: string): string {
  return `auth:family:${familyId}`;
}

function userSessionsKey(userId: string): string {
  return `auth:sessions:${userId}`;
}

interface SessionRecord {
  userId: string;
  familyId: string;
  refreshTokenHash: string;
  /** Epoch ms after which no rotation may extend this chain. */
  absoluteExpiresAt: number;
}

function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Constant-time comparison. Both sides are digests rather than secrets, so a
 * leak here is not directly exploitable, but comparing them with `===` returns
 * sooner the earlier they differ, which is free information.
 */
function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");

  return left.length === right.length && timingSafeEqual(left, right);
}

function parseSession(raw: string): SessionRecord | null {
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
async function revokeSession(
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
async function revokeFamily(familyId: string): Promise<void> {
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

/** Revokes every session a user has, for "sign out everywhere". */
async function revokeAllSessions(userId: string): Promise<number> {
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
async function storeSession(
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

/* Rate limiting --------------------------------------------------------- */

type RateLimitScope = "signup" | "login" | "refresh" | "logout" | "google";

/**
 * `req.ip` reports IPv4 callers as IPv4-mapped IPv6 (`::ffff:127.0.0.1`) on a
 * dual-stack listener, so one client would otherwise get a counter per
 * protocol and twice the allowance just by switching.
 */
function clientIp(req: Request): string {
  const ip = req.ip || req.socket.remoteAddress || "unknown";

  return ip.startsWith("::ffff:") ? ip.slice("::ffff:".length) : ip;
}

function rateLimitKey(req: Request, scope: RateLimitScope): string {
  /**
   * Namespaced away from `auth:refresh:<sessionId>`: with counters at
   * `auth:<scope>:<ip>`, the refresh limiter's key was `auth:refresh:<ip>`,
   * sitting inside the session keyspace. Nothing can forge a session id that
   * looks like an IP, but anything scanning `auth:refresh:*` would have
   * counted limiters as sessions.
   */
  return `auth:ratelimit:${scope}:${clientIp(req)}`;
}

/**
 * Throws 429 when the caller is out of budget. This only reads the counter;
 * routes record attempts themselves, which is what lets login charge for
 * failures alone. Charging every request would spend a shared office IP's
 * allowance on people signing in successfully, and refunding on success would
 * let anyone holding one valid account clear the counter and buy ten fresh
 * guesses at everyone else's.
 */
async function assertWithinRateLimit(
  req: Request,
  scope: RateLimitScope,
  limit: number,
): Promise<void> {
  const { limited, retryAfter } = await isRateLimited(
    rateLimitKey(req, scope),
    limit,
  );

  if (limited) {
    throw HttpError.tooManyRequests(
      `Too many ${scope} attempts. Please try again later.`,
      retryAfter || RATE_LIMIT_WINDOW_SECONDS,
    );
  }
}

function chargeRateLimit(req: Request, scope: RateLimitScope): Promise<void> {
  return recordAttempt(rateLimitKey(req, scope), RATE_LIMIT_WINDOW_SECONDS);
}

/* Cookie ---------------------------------------------------------------- */

function readRefreshCookie(req: Request): string | null {
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

function setRefreshCookie(res: Response, token: string, ttl: number): void {
  res.cookie(REFRESH_TOKEN_COOKIE, token, {
    ...refreshCookieOptions,
    maxAge: ttl * 1000,
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_TOKEN_COOKIE, refreshCookieOptions);
}

/**
 * Issues a session and its tokens. Shared by login and rotation so the two
 * cannot disagree about how a session is built.
 */
async function issueSession(
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

/* Routes ---------------------------------------------------------------- */

router.post("/signup", async (req, res) => {
  await assertWithinRateLimit(req, "signup", 5);
  await chargeRateLimit(req, "signup");

  const { username, email, password } = parseOrThrow(signupSchema, req.body);

  const [existingUsername, existingEmail] = await Promise.all([
    db.orm.auth.User.where((u) => u.username.eq(username)).first(),
    db.orm.auth.User.where((u) => u.email.eq(email)).first(),
  ]);

  if (existingUsername || existingEmail) {
    throw HttpError.conflict("That username or email is already taken.");
  }

  const passwordHash = await argon2.hash(password);

  let user;

  try {
    user = await db.orm.auth.User.create({ username, email, passwordHash });
  } catch (error) {
    // The check above races other signups; the unique index is the real
    // arbiter, and 23505 is its way of saying someone got there first.
    if (
      error instanceof Error &&
      "sqlState" in error &&
      (error as { sqlState?: string }).sqlState === "23505"
    ) {
      throw HttpError.conflict("That username or email is already taken.");
    }

    throw error;
  }

  res.status(201).json({
    message: "Account created successfully",
    user: { id: user.id, username: user.username, email: user.email },
  });
});

router.post("/login", async (req, res) => {
  await assertWithinRateLimit(req, "login", 10);

  const { email, password } = parseOrThrow(loginSchema, req.body);

  const user = await db.orm.auth.User.where((u) => u.email.eq(email)).first();

  /**
   * Verifying a dummy hash keeps an unknown email indistinguishable from a
   * known one, in both timing and response. A *null* hash takes the same path:
   * a Google-only account has no password, and saying so would confirm the
   * address is registered.
   */
  const passwordValid =
    user && user.passwordHash !== null
      ? await argon2.verify(user.passwordHash, password)
      : (await argon2.verify(DUMMY_PASSWORD_HASH, password), false);

  if (!user || !passwordValid) {
    await chargeRateLimit(req, "login");

    throw HttpError.unauthorized("Invalid email or password.");
  }

  const accessToken = await issueSession(
    res,
    user.id,
    randomBytes(32).toString("hex"),
    Date.now() + ABSOLUTE_SESSION_TTL_SECONDS * 1000,
  );

  res.status(200).json({
    message: "Login successful",
    accessToken,
    user: { id: user.id, username: user.username, email: user.email },
  });
});

router.post("/refresh", async (req, res) => {
  await assertWithinRateLimit(req, "refresh", 60);
  await chargeRateLimit(req, "refresh");

  const refreshToken = readRefreshCookie(req);

  if (!refreshToken) {
    throw HttpError.unauthorized("Refresh token missing.");
  }

  const payload = verifyRefreshToken(refreshToken);

  if (!payload) {
    throw HttpError.unauthorized("Invalid or expired refresh token.");
  }

  const raw = await redis.get(sessionKey(payload.sid));

  if (!raw) {
    /**
     * The token verifies but its session is gone. If the chain is still alive,
     * this token was already rotated and is being replayed — burn the chain.
     */
    await revokeFamily(payload.fid);
    clearRefreshCookie(res);

    throw HttpError.unauthorized("Session expired or revoked.");
  }

  const session = parseSession(raw);

  if (!session) {
    await redis.del(sessionKey(payload.sid));
    clearRefreshCookie(res);

    throw HttpError.unauthorized("Session expired or revoked.");
  }

  if (
    session.userId !== payload.sub ||
    session.familyId !== payload.fid ||
    !hashesMatch(hashRefreshToken(refreshToken), session.refreshTokenHash)
  ) {
    // A token that verifies but does not match the session it names points at
    // a leaked chain rather than an honest mistake.
    await revokeFamily(session.familyId);
    clearRefreshCookie(res);

    throw HttpError.unauthorized("Invalid refresh token.");
  }

  if (session.absoluteExpiresAt <= Date.now()) {
    await revokeSession(payload.sid, session);
    clearRefreshCookie(res);

    throw HttpError.unauthorized("Session expired. Please sign in again.");
  }

  /**
   * Rotate. `DEL` reports how many keys it removed, and that makes it the
   * mutex: concurrent replays of one token all get past the `GET` above, but
   * exactly one gets a 1 back here. Ignoring this result let a single token
   * mint a session per concurrent request.
   */
  const rotated = await redis.del(sessionKey(payload.sid));

  if (rotated === 0) {
    throw HttpError.unauthorized("Invalid refresh token.");
  }

  await redis.zRem(userSessionsKey(session.userId), payload.sid);

  const accessToken = await issueSession(
    res,
    session.userId,
    session.familyId,
    session.absoluteExpiresAt,
  );

  res.status(200).json({
    message: "Token refreshed successfully",
    accessToken,
  });
});

/**
 * Idempotent by design: an unverifiable or already-revoked cookie still leaves
 * the caller without one. A logout that can fail leaves a dead cookie in the
 * browser that nothing can clear.
 */
router.post("/logout", async (req, res) => {
  await assertWithinRateLimit(req, "logout", 30);
  await chargeRateLimit(req, "logout");

  const refreshToken = readRefreshCookie(req);
  const payload = refreshToken ? verifyRefreshToken(refreshToken) : null;

  if (payload) {
    const raw = await redis.get(sessionKey(payload.sid));
    const session = raw ? parseSession(raw) : null;

    if (session) {
      await revokeSession(payload.sid, session);
    } else {
      await redis.del([sessionKey(payload.sid), familyKey(payload.fid)]);
    }
  }

  clearRefreshCookie(res);

  res.status(200).json({ message: "Logged out successfully" });
});

/**
 * Signs the user out of every device. Authorised by the refresh cookie rather
 * than an access token: it proves possession of a live session, and it is the
 * credential this router already scopes its cookie path to.
 */
router.post("/logout-all", async (req, res) => {
  await assertWithinRateLimit(req, "logout", 30);
  await chargeRateLimit(req, "logout");

  const refreshToken = readRefreshCookie(req);
  const payload = refreshToken ? verifyRefreshToken(refreshToken) : null;

  if (!payload) {
    clearRefreshCookie(res);

    throw HttpError.unauthorized("Refresh token missing or invalid.");
  }

  const raw = await redis.get(sessionKey(payload.sid));
  const session = raw ? parseSession(raw) : null;

  if (!session || session.userId !== payload.sub) {
    clearRefreshCookie(res);

    throw HttpError.unauthorized("Session expired or revoked.");
  }

  const revoked = await revokeAllSessions(session.userId);

  clearRefreshCookie(res);

  res.status(200).json({
    message: "Signed out of all sessions",
    revoked,
  });
});

/* Google sign-in --------------------------------------------------------- */

const googleSchema = z.object({
  idToken: z.string().min(1).max(4096),
});

/**
 * Google supplies a name and an email, never a username, but ours is required
 * and unique. Derive a candidate from the email's local part, fall back to the
 * name, and fall back again to a generic stem — then let the caller retry with
 * a fresh suffix if the unique index objects.
 */
function deriveUsername(identity: {
  email: string;
  name: string | null;
}): string {
  const source = identity.email.split("@")[0] ?? identity.name ?? "reader";

  const base = source
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 16);

  // The suffix keeps derived names from colliding constantly, and keeps one
  // user's email local part from being guessable as another's username.
  const suffix = randomBytes(3).toString("hex");

  return `${base.length >= 3 ? base : "reader"}_${suffix}`;
}

/**
 * Exchanges a Google ID token for one of our sessions.
 *
 * The token is verified against Google's keys with our client id as the
 * audience, so a token minted for another application — validly signed by
 * Google — is refused. On success this issues exactly what `/login` issues, so
 * everything downstream (rotation, replay detection, revocation) behaves
 * identically regardless of how the user signed in.
 */
router.post("/google", async (req, res) => {
  await assertWithinRateLimit(req, "google", 20);
  await chargeRateLimit(req, "google");

  const { idToken } = parseOrThrow(googleSchema, req.body);

  const identity = await verifyGoogleIdToken(idToken);

  if (!identity) {
    throw HttpError.unauthorized("Google sign-in failed. Please try again.");
  }

  /**
   * An unverified address must not be trusted: it is what makes matching an
   * existing account by email safe at all.
   */
  if (!identity.emailVerified) {
    throw HttpError.unauthorized(
      "Your Google email address is not verified.",
    );
  }

  let user = await db.orm.auth.User.where((u) =>
    u.googleId.eq(identity.googleId),
  ).first();

  /** Lets the client route a brand-new account into onboarding. */
  let created = false;

  if (user) {
    // Keep the profile fields fresh, but never overwrite a name the user set.
    await db.orm.auth.User.where((u) => u.id.eq(user!.id)).update({
      displayName: user.displayName ?? identity.name,
      avatarUrl: identity.picture,
      emailVerified: true,
    });
  } else {
    const byEmail = await db.orm.auth.User.where((u) =>
      u.email.eq(identity.email),
    ).first();

    if (byEmail) {
      /**
       * Same address, no Google link yet: adopt it. Safe only because Google
       * asserted the address is verified.
       *
       * Existing sessions are revoked as a precaution. If this account was
       * created by someone squatting the address before its owner arrived,
       * their sessions die here.
       */
      await db.orm.auth.User.where((u) => u.id.eq(byEmail.id)).update({
        googleId: identity.googleId,
        displayName: byEmail.displayName ?? identity.name,
        avatarUrl: byEmail.avatarUrl ?? identity.picture,
        emailVerified: true,
      });

      await revokeAllSessions(byEmail.id);

      user = await db.orm.auth.User.where((u) => u.id.eq(byEmail.id)).first();
    } else {
      // Retry on a username collision: the unique index is the arbiter, and a
      // derived name can lose a race with another signup.
      for (let attempt = 0; attempt < 5 && !user; attempt += 1) {
        try {
          created = true;
          user = await db.orm.auth.User.create({
            username: deriveUsername(identity),
            email: identity.email,
            passwordHash: null,
            googleId: identity.googleId,
            displayName: identity.name,
            avatarUrl: identity.picture,
            emailVerified: true,
          });
        } catch (error) {
          const isConflict =
            error instanceof Error &&
            "sqlState" in error &&
            (error as { sqlState?: string }).sqlState === "23505";

          if (!isConflict) throw error;

          // A concurrent request may have created this exact Google user.
          created = false;
          user = await db.orm.auth.User.where((u) =>
            u.googleId.eq(identity.googleId),
          ).first();
        }
      }
    }
  }

  if (!user) {
    throw new HttpError(
      500,
      "internal_error",
      "Could not create your account. Please try again.",
    );
  }

  const accessToken = await issueSession(
    res,
    user.id,
    randomBytes(32).toString("hex"),
    Date.now() + ABSOLUTE_SESSION_TTL_SECONDS * 1000,
  );

  res.status(200).json({
    message: "Login successful",
    accessToken,
    created,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
    },
  });
});

export default router;
