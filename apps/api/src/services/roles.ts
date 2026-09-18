/**
 * Who may act on the platform rather than only on their own rows, and who
 * may no longer act at all.
 *
 * Scribe has one privileged flag, `auth.User.isAdmin`, and this is the only
 * place it is read. Writing challenges is what needed it first; everything
 * later that has to ask "may this person act for the platform?" -- moderating
 * reported content, hiding a post, suspending an account -- asks here rather
 * than inventing a second mechanism, which is how three code paths end up
 * disagreeing about who a moderator is.
 *
 * A boolean rather than a role enum. There is exactly one privileged set of
 * actions today, so `MODERATOR` and `ADMIN` would be two names for the same
 * permission and nothing would enforce the difference; widening this into an
 * enum is a migration whenever those actually diverge. What must not happen
 * in the meantime is a second, parallel notion of "staff".
 *
 * Nothing grants the flag over HTTP. `scripts/grant-admin.ts` sets it against
 * the database, so no request -- however authenticated -- can escalate
 * itself, and there is no endpoint to forget to protect.
 *
 * `assertNotSuspended` is the other half of the same question and lives here
 * for the same reason: it is about the *person*, not about the row they are
 * reaching for, and the day it is read from two places is the day the two
 * disagree about what a suspension stops.
 */

import { db } from "../prisma/db.js";
import { HttpError } from "../lib/http-error.js";

/** Whether this account may act for the platform. */
export async function isAdmin(userId: string): Promise<boolean> {
  const row = await db.orm.auth.User.select("isAdmin")
    .where((user) => user.id.eq(userId))
    .first();

  return row?.isAdmin === true;
}

/**
 * Insists on it.
 *
 * 403 rather than 404: the caller is who they say they are and still may not
 * do this, so a client must not respond by signing them out. Hiding the
 * route's existence behind a 404 would buy nothing -- the paths are in the
 * client bundle either way.
 */
export async function assertAdmin(userId: string): Promise<void> {
  if (!(await isAdmin(userId))) {
    throw HttpError.forbidden("Only an administrator can do that.");
  }
}

/**
 * Refuses a suspended account.
 *
 * Suspension stops writing and nothing else -- a suspended reader still
 * reads, still has a library, still has a streak. That is what makes this a
 * check at the write seams rather than in `requireUser`: putting it there
 * would cost every request a query to answer a question only a handful of
 * them ask, and would turn a suspension into a sign-out, which is a different
 * and much blunter thing.
 *
 * The seams that call it are listed in the header of `services/moderation.ts`.
 * A new one that accepts user-written text joins that list; nothing here can
 * make it.
 *
 * 403 and a message that names the reason, because an account told only
 * "forbidden" reads the refusal as a bug and files a support ticket about it.
 */
export async function assertNotSuspended(userId: string): Promise<void> {
  const row = await db.orm.auth.User.select("suspendedAt")
    .where((user) => user.id.eq(userId))
    .first();

  const suspendedAt = row?.suspendedAt;
  if (suspendedAt === null || suspendedAt === undefined) return;

  throw HttpError.forbidden(
    "Your account is suspended, so you cannot post right now.",
  );
}
