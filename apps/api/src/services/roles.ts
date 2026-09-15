/**
 * Who may act on the platform rather than only on their own rows.
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
