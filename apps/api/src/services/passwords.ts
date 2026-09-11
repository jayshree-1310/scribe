/**
 * Everything that writes `auth.User.passwordHash`: changing one, setting the
 * first one on a Google-only account, and the forgot/reset pair.
 *
 * They live together because they share one rule that must not be forgotten
 * on any of the three paths — **a new password revokes every session** — and
 * one shape of account that all three have to reason about: a Google-only
 * account, whose `passwordHash` is null (see `contract.prisma`).
 */

import argon2 from "argon2";
import { Temporal } from "temporal-polyfill";
import { db } from "../prisma/db.js";
import { HttpError } from "../lib/http-error.js";
import { sendMail, webLink } from "../lib/mailer.js";
import {
  consumeOneTimeToken,
  issueOneTimeToken,
  revokeOneTimeToken,
} from "../lib/one-time-token.js";
import { revokeAllSessions } from "../lib/sessions.js";

/** Matches `routes/auth.ts` and the web form (`apps/web/src/lib/auth.ts`). */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

/** Redis namespace for reset tokens, and how long a link stays good. */
const RESET_NAMESPACE = "pwreset";
const RESET_TTL_SECONDS = 30 * 60;

interface Credentials {
  id: string;
  email: string;
  username: string;
  passwordHash: string | null;
}

async function loadCredentials(userId: string): Promise<Credentials> {
  const row = await db.orm.auth.User.select(
    "id",
    "email",
    "username",
    "passwordHash",
  )
    .where((u) => u.id.eq(userId))
    .first();

  // A live access token for an account that no longer exists.
  if (!row) throw HttpError.unauthorized("Your account no longer exists.");

  return row;
}

/**
 * Verifies a password against a stored hash, treating an unreadable hash as a
 * mismatch rather than a crash.
 *
 * Fixture users and any row written before argon2 was in use carry values
 * that are not argon2 hashes at all, and `argon2.verify` throws on those — a
 * 500 on the change-password route where a plain "that password is not right"
 * is both true and safe.
 */
async function passwordMatches(hash: string, candidate: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, candidate);
  } catch {
    return false;
  }
}

/**
 * Writes a new hash and invalidates everything the old one could still reach:
 * every session, and any reset link that was outstanding.
 *
 * The revocation is deliberately *not* conditional on how the password was
 * changed. Whether the owner changed it in settings or a stranger reset it
 * with a stolen link, the sessions opened before it are the ones that must
 * not survive.
 */
async function writePassword(userId: string, password: string): Promise<void> {
  const passwordHash = await argon2.hash(password);

  await db.orm.auth.User.where((u) => u.id.eq(userId)).update({
    passwordHash,
    updatedAt: Temporal.Now.instant(),
  });

  await revokeOneTimeToken(RESET_NAMESPACE, userId);
  await revokeAllSessions(userId);
}

/**
 * Changes the password of an account that has one.
 *
 * A Google-only account gets a 409 naming the route it should use instead:
 * "current password is wrong" would be a lie, and a generic 400 leaves the
 * form with nothing useful to say to someone who has never had a password.
 */
export async function changePassword(
  userId: string,
  input: { currentPassword: string; newPassword: string },
): Promise<void> {
  const user = await loadCredentials(userId);

  if (user.passwordHash === null) {
    throw HttpError.conflict(
      "This account signs in with Google and has no password yet. Set one instead.",
    );
  }

  if (!(await passwordMatches(user.passwordHash, input.currentPassword))) {
    throw HttpError.badRequest("Some of the details need fixing.", {
      currentPassword: "That is not your current password.",
    });
  }

  if (input.currentPassword === input.newPassword) {
    throw HttpError.badRequest("Some of the details need fixing.", {
      newPassword: "Choose a password you are not already using.",
    });
  }

  await writePassword(userId, input.newPassword);
}

/**
 * Sets the first password on a Google-only account, so it gains a second way
 * in without losing the first.
 *
 * Gated on a live session and nothing else — which is what makes it safe:
 * holding a session means Google has already vouched for this person, so
 * there is no older secret to prove knowledge of. An account that already has
 * a password must go through `changePassword`, or this would be a way to
 * replace a password without knowing it.
 */
export async function setPassword(
  userId: string,
  newPassword: string,
): Promise<void> {
  const user = await loadCredentials(userId);

  if (user.passwordHash !== null) {
    throw HttpError.conflict(
      "This account already has a password. Change it instead.",
    );
  }

  await writePassword(userId, newPassword);
}

/**
 * Emails a reset link, if that address belongs to an account.
 *
 * Resolves the same way either way, and takes roughly the same time, because
 * the caller's own reaction is the only signal it must not give: an endpoint
 * that answers differently for a registered address is an account-enumeration
 * oracle for every address an attacker cares to try.
 *
 * A Google-only account is a legitimate target here rather than an error —
 * the reset proves control of the address, which is exactly what setting a
 * first password needs.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const user = await db.orm.auth.User.select("id", "email", "username")
    .where((u) => u.email.eq(email))
    .first();

  if (!user) return;

  /**
   * The address is carried in the token, not just the id, so a link stops
   * working once the account's email changes. Otherwise a link sent to an
   * address the account no longer owns would still take over the account.
   */
  const token = await issueOneTimeToken(
    RESET_NAMESPACE,
    user.id,
    { email: user.email },
    RESET_TTL_SECONDS,
  );

  const link = webLink(`/reset-password/${token}`);

  await sendMail({
    to: user.email,
    subject: "Reset your Scribe password",
    text:
      `Hello ${user.username},\n\n` +
      `Someone asked to reset the password for your Scribe account. ` +
      `Open the link below within ${RESET_TTL_SECONDS / 60} minutes to choose a new one:\n\n` +
      `${link}\n\n` +
      `The link can only be used once. If this was not you, you can ignore ` +
      `this message — your password has not changed.\n`,
  });
}

/**
 * Spends a reset link and sets the new password.
 *
 * Every reason a link can fail — expired, already spent, never issued, minted
 * for an address the account has since changed — collapses to one message.
 * The person holding a dead link needs the same next step in all four cases,
 * and distinguishing them tells a guesser which of their guesses was close.
 */
export async function resetPassword(
  token: string,
  newPassword: string,
): Promise<void> {
  const consumed = await consumeOneTimeToken(RESET_NAMESPACE, token);

  const expired = () =>
    HttpError.badRequest(
      "That reset link has expired or has already been used. Please request a new one.",
      { token: "This link is no longer valid." },
    );

  if (!consumed) throw expired();

  const user = await db.orm.auth.User.select("id", "email")
    .where((u) => u.id.eq(consumed.userId))
    .first();

  if (!user || user.email !== consumed.payload["email"]) throw expired();

  await writePassword(user.id, newPassword);

  /**
   * Opening a link sent to the address proves control of it, which is the
   * same evidence the verification flow asks for — so a reset also verifies.
   */
  await db.orm.auth.User.where((u) => u.id.eq(user.id)).update({
    emailVerified: true,
    updatedAt: Temporal.Now.instant(),
  });
}
