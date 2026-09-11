/**
 * Credential management: passwords and email verification.
 *
 * Mounted at `/api/auth` alongside `routes/auth.ts` rather than under
 * `/api/account`, for two reasons. The refresh cookie is scoped to
 * `/api/auth`, so this is where a route can rotate the caller's session; and
 * four of the six endpoints here are reachable *without* a session, which is
 * the opposite of what the account router promises.
 */

import { Router } from "express";
import { z } from "zod";
import { parseOrThrow } from "../lib/validate.js";
import { emailSchema, passwordSchema } from "../lib/auth-schemas.js";
import {
  assertWithinLimit,
  assertWithinRateLimit,
  chargeLimit,
  chargeRateLimit,
  emailSubject,
} from "../lib/auth-rate-limit.js";
import { requireUser, requireUserId } from "../middleware/current-user.js";
import { startSession } from "../lib/sessions.js";
import {
  sendVerificationEmail,
  verifyEmail,
} from "../services/email-verification.js";
import {
  changePassword,
  requestPasswordReset,
  resetPassword,
  setPassword,
} from "../services/passwords.js";

const router = Router();

/** Opaque to everything but Redis; only the length is worth validating. */
const tokenSchema = z.string().trim().min(20).max(256);

const forgotSchema = z.object({ email: emailSchema });

const resetSchema = z.object({
  token: tokenSchema,
  password: passwordSchema,
});

const changeSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password.").max(128),
  newPassword: passwordSchema,
});

const setSchema = z.object({ password: passwordSchema });

const verifySchema = z.object({ token: tokenSchema });

/* Password reset -------------------------------------------------------- */

/**
 * Two budgets, because they stop different things. The per-IP one stops a
 * script walking a list of addresses; the per-address one stops anyone using
 * us to flood one person's inbox, which no per-IP limit catches once the
 * requests come from different places.
 *
 * Both are charged before the work, unlike login: there is no "failure" to
 * charge for here, since the response is the same either way.
 */
router.post("/forgot-password", async (req, res, next) => {
  try {
    await assertWithinRateLimit(req, "forgot", 10);
    await chargeRateLimit(req, "forgot");

    const { email } = parseOrThrow(forgotSchema, req.body);

    const subject = emailSubject(email);
    await assertWithinLimit("forgot", subject, 3);
    await chargeLimit("forgot", subject);

    await requestPasswordReset(email);

    /**
     * Deliberately the same body whether or not that address has an account.
     * The service does not report which it was, so there is nothing here that
     * could accidentally start branching on it.
     */
    res.status(200).json({
      message:
        "If that address has a Scribe account, a reset link is on its way.",
    });
  } catch (error) {
    next(error);
  }
});

router.post("/reset-password", async (req, res, next) => {
  try {
    await assertWithinRateLimit(req, "reset", 20);
    await chargeRateLimit(req, "reset");

    const { token, password } = parseOrThrow(resetSchema, req.body);

    await resetPassword(token, password);

    /**
     * No session is issued. Resetting revokes every session including any the
     * attacker who prompted the reset was holding, and signing the caller
     * straight in from a link in an email is the one flow where that link
     * being forwarded or logged matters most. They sign in with the new
     * password, which also confirms they remember it.
     */
    res.status(200).json({
      message: "Your password has been changed. Please sign in.",
    });
  } catch (error) {
    next(error);
  }
});

/* Passwords, for a signed-in caller ------------------------------------- */

/**
 * Both password writes revoke every session the account has — see
 * `services/passwords.ts` — and then `startSession` issues a new one for the
 * caller, so the person who just changed their password stays where they are
 * while every other device is signed out.
 */
router.post("/change-password", requireUser, async (req, res, next) => {
  try {
    const userId = requireUserId(res);

    // Keyed per account, not per address: this is a guessing game against one
    // known user, and the caller's IP is the attacker's to change.
    await assertWithinLimit("password", userId, 10);
    await chargeLimit("password", userId);

    const body = parseOrThrow(changeSchema, req.body);

    await changePassword(userId, body);

    res.status(200).json({
      message: "Password updated. Other devices have been signed out.",
      accessToken: await startSession(res, userId),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/set-password", requireUser, async (req, res, next) => {
  try {
    const userId = requireUserId(res);

    await assertWithinLimit("password", userId, 10);
    await chargeLimit("password", userId);

    const { password } = parseOrThrow(setSchema, req.body);

    await setPassword(userId, password);

    res.status(200).json({
      message: "Password set. Other devices have been signed out.",
      accessToken: await startSession(res, userId),
    });
  } catch (error) {
    next(error);
  }
});

/* Email verification ---------------------------------------------------- */

router.post("/send-verification", requireUser, async (req, res, next) => {
  try {
    const userId = requireUserId(res);

    await assertWithinLimit("verify", userId, 5);
    await chargeLimit("verify", userId);

    await sendVerificationEmail(userId);

    // Same answer for an already-verified account: the caller's next step is
    // identical, and the banner that triggered this is about to disappear.
    res.status(200).json({ message: "Check your inbox for the link." });
  } catch (error) {
    next(error);
  }
});

/**
 * Public: the token in the link is the credential, and the person clicking it
 * from their mail client very often has no session in that browser.
 */
router.post("/verify-email", async (req, res, next) => {
  try {
    await assertWithinRateLimit(req, "verify", 20);
    await chargeRateLimit(req, "verify");

    const { token } = parseOrThrow(verifySchema, req.body);

    const { email } = await verifyEmail(token);

    res.status(200).json({ message: "Email address confirmed.", email });
  } catch (error) {
    next(error);
  }
});

export default router;
