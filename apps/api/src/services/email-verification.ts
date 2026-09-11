/**
 * Proving that the address on an account belongs to the person using it.
 *
 * Google sign-in already asserts this (`routes/auth.ts` refuses an
 * unverified Google address), so this flow exists for password signups and
 * for anyone who changes their email in settings — `services/account.ts`
 * clears the flag on an email change for exactly that reason.
 */

import { Temporal } from "temporal-polyfill";
import { db } from "../prisma/db.js";
import { HttpError } from "../lib/http-error.js";
import { sendMail, webLink } from "../lib/mailer.js";
import { consumeOneTimeToken, issueOneTimeToken } from "../lib/one-time-token.js";

const VERIFY_NAMESPACE = "verify";

/**
 * A day, rather than the reset flow's half hour. This link only proves an
 * address; it cannot change a credential, so an unopened one sitting in an
 * inbox is not the same kind of liability.
 */
const VERIFY_TTL_SECONDS = 24 * 60 * 60;

/**
 * Sends a verification link to the caller's current address.
 *
 * A no-op for an already-verified account: re-sending would let anyone with a
 * session generate mail to an address on demand, and there is nothing to
 * prove.
 */
export async function sendVerificationEmail(userId: string): Promise<void> {
  const user = await db.orm.auth.User.select(
    "id",
    "email",
    "username",
    "emailVerified",
  )
    .where((u) => u.id.eq(userId))
    .first();

  if (!user) throw HttpError.unauthorized("Your account no longer exists.");
  if (user.emailVerified) return;

  const token = await issueOneTimeToken(
    VERIFY_NAMESPACE,
    user.id,
    { email: user.email },
    VERIFY_TTL_SECONDS,
  );

  await sendMail({
    to: user.email,
    subject: "Confirm your Scribe email address",
    text:
      `Hello ${user.username},\n\n` +
      `Confirm this address so we can reach you about your account:\n\n` +
      `${webLink(`/verify-email/${token}`)}\n\n` +
      `The link is good for 24 hours. If you did not create a Scribe ` +
      `account, you can ignore this message.\n`,
  });
}

/** What the caller is told about the address it just proved. */
export interface VerifiedEmail {
  email: string;
}

/**
 * Spends a verification link.
 *
 * The token carries the address it was sent to, and a mismatch is refused:
 * without that, a link mailed to the old address would still verify the
 * account after its email was changed to one nobody has proven.
 */
export async function verifyEmail(token: string): Promise<VerifiedEmail> {
  const consumed = await consumeOneTimeToken(VERIFY_NAMESPACE, token);

  const dead = () =>
    HttpError.badRequest(
      "That confirmation link has expired or has already been used. Please request a new one.",
      { token: "This link is no longer valid." },
    );

  if (!consumed) throw dead();

  const user = await db.orm.auth.User.select("id", "email")
    .where((u) => u.id.eq(consumed.userId))
    .first();

  if (!user || user.email !== consumed.payload["email"]) throw dead();

  await db.orm.auth.User.where((u) => u.id.eq(user.id)).update({
    emailVerified: true,
    updatedAt: Temporal.Now.instant(),
  });

  return { email: user.email };
}
