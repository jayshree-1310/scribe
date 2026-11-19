/**
 * Sign-in and session lifecycle: signup, login, refresh, logout and Google.
 *
 * Everything that *stores* a session lives in `lib/sessions.ts`, and the
 * password and email-verification routes live in `routes/auth-security.ts` —
 * both mounted at `/api/auth`. The split is what keeps this file readable now
 * that six more endpoints hang off the same prefix.
 */

import { Router } from "express";
import { z } from "zod";
import argon2 from "argon2";
import { randomBytes } from "node:crypto";
import { db } from "../prisma/db.js";
import { HttpError } from "../lib/http-error.js";
import { parseOrThrow } from "../lib/validate.js";
import {
  emailSchema,
  passwordSchema,
  usernameSchema,
} from "../lib/auth-schemas.js";
import { createAccessToken, verifyRefreshToken } from "../lib/jwt.js";
import { verifyGoogleIdToken } from "../lib/google.js";
import { redis } from "../lib/redis.js";
import { storage } from "../lib/storage.js";
import {
  assertWithinRateLimit,
  chargeRateLimit,
} from "../lib/auth-rate-limit.js";
import {
  clearRefreshCookie,
  familyKey,
  hashRefreshToken,
  hashesMatch,
  issueSession,
  parseSession,
  readRefreshCookie,
  revokeAllSessions,
  revokeFamily,
  revokeSession,
  rotatedKey,
  ROTATION_GRACE_SECONDS,
  sessionKey,
  startSession,
  userSessionsKey,
} from "../lib/sessions.js";

const router = Router();

const signupSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
});

const loginSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  /** "Remember me". Unticked, the session ends when the browser closes. */
  rememberMe: z.boolean().default(true),
});

const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,p=4,t=3$xNteWUCFVchT8WWZ+0XcgQ$J2wuSEHpgb09Rthx8cxqCsoxyOP821vImY7a8Knaqf4";

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

  const { email, password, rememberMe } = parseOrThrow(loginSchema, req.body);

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

  const accessToken = await startSession(res, user.id, rememberMe);

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
    // Rotated a moment ago by another tab or an earlier request: see
    // `ROTATION_GRACE_SECONDS`.
    const graced = await graceAccessToken(refreshToken, payload);

    if (graced) {
      res.status(200).json({ message: "Token refreshed successfully", accessToken: graced });
      return;
    }

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
   * Rotate. Claiming the grace marker with `NX` is the mutex: concurrent
   * requests with one token all get past the `GET` above, but exactly one
   * claims it and mints the next session. The rest are inside the grace
   * period by definition, and get an access token without a new session --
   * one token must never mint a session per concurrent request.
   */
  const claimed = await redis.set(rotatedKey(payload.sid), JSON.stringify(session), {
    NX: true,
    EX: ROTATION_GRACE_SECONDS,
  });

  if (claimed === null) {
    const graced = await graceAccessToken(refreshToken, payload);
    if (!graced) throw HttpError.unauthorized("Invalid refresh token.");

    res.status(200).json({ message: "Token refreshed successfully", accessToken: graced });
    return;
  }

  await redis.del(sessionKey(payload.sid));

  await redis.zRem(userSessionsKey(session.userId), payload.sid);

  const accessToken = await issueSession(
    res,
    session.userId,
    session.familyId,
    session.absoluteExpiresAt,
    session.persistent !== false,
  );

  res.status(200).json({
    message: "Token refreshed successfully",
    accessToken,
  });
});

/**
 * An access token for a refresh token rotated within the grace period, or
 * null when it was not. The chain has to be alive still: a logout, a password
 * change or a replay burn deletes the family, and a token from a revoked chain
 * gets nothing however recently it was rotated.
 */
async function graceAccessToken(
  refreshToken: string,
  payload: { sub: string; sid: string; fid: string },
): Promise<string | null> {
  const raw = await redis.get(rotatedKey(payload.sid));
  const rotated = raw ? parseSession(raw) : null;

  if (
    !rotated ||
    rotated.userId !== payload.sub ||
    rotated.familyId !== payload.fid ||
    !hashesMatch(hashRefreshToken(refreshToken), rotated.refreshTokenHash) ||
    rotated.absoluteExpiresAt <= Date.now()
  ) {
    return null;
  }

  if ((await redis.exists(familyKey(payload.fid))) === 0) return null;

  return createAccessToken(rotated.userId);
}

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
  // `||`, not `??`: `split` always yields a string, so only an empty local
  // part should fall through to the name.
  const source = identity.email.split("@")[0] || identity.name || "reader";

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
    /**
     * Keep the profile fields fresh, but never overwrite what the user chose:
     * a name they set, or an avatar they uploaded in Settings. A Google
     * picture (or none) is refreshed, so a changed Google photo follows.
     */
    const uploadedAvatar =
      user.avatarUrl !== null && storage.keyOf(user.avatarUrl) !== null;
    // A moderator's take-down nulled these on purpose; refilling them from
    // Google would undo it on the next sign-in.
    const profileHidden =
      user.profileHiddenAt !== null && user.profileHiddenAt !== undefined;

    await db.orm.auth.User.where((u) => u.id.eq(user!.id)).update({
      ...(profileHidden
        ? {}
        : {
            displayName: user.displayName ?? identity.name,
            avatarUrl: uploadedAvatar
              ? user.avatarUrl
              : (identity.picture ?? user.avatarUrl),
          }),
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
       * If *we* never verified it, the account may have been created by
       * somebody squatting the address before its owner arrived (account
       * pre-hijacking). Their password is cleared, so only the address's
       * owner can sign in from here on; the owner can set a new one from
       * Settings (`/set-password`). An account that had verified its email
       * is the owner's own, and keeps its password.
       *
       * Existing sessions are revoked either way, so a squatter's sessions die
       * here too.
       */
      await db.orm.auth.User.where((u) => u.id.eq(byEmail.id)).update({
        googleId: identity.googleId,
        ...(byEmail.profileHiddenAt !== null && byEmail.profileHiddenAt !== undefined
          ? {}
          : {
              displayName: byEmail.displayName ?? identity.name,
              avatarUrl: byEmail.avatarUrl ?? identity.picture,
            }),
        emailVerified: true,
        ...(byEmail.emailVerified ? {} : { passwordHash: null }),
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

  const accessToken = await startSession(res, user.id);

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
