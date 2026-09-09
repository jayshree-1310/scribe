import type { Request, RequestHandler } from "express";
import { HttpError } from "../lib/http-error.js";

/**
 * The single seam through which the Books + Library feature learns who is
 * asking.
 *
 * Authentication is being built separately, so this file deliberately contains
 * no token logic of its own. It reads `req.user.id` — the property an auth
 * middleware conventionally populates — and falls back, outside production
 * only, to an `X-Scribe-User-Id` header so the feature is usable end to end
 * before that middleware exists.
 *
 * When the real middleware lands, mount it ahead of these routes and delete
 * the development fallback below. Nothing else in the feature changes.
 */

/** Shape an auth middleware is expected to attach to the request. */
interface RequestWithUser extends Request {
  user?: { id?: string } | undefined;
}

/** Header honoured only outside production, standing in for a real session. */
export const DEV_USER_HEADER = "x-scribe-user-id";

function devFallbackEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}

/**
 * Returns the signed-in reader's id, or `null` when the request is anonymous.
 * Used directly by routes that work either way, such as book browsing, which
 * annotates results with the caller's shelf status when there is a caller.
 */
export function getUserId(req: Request): string | null {
  const fromAuth = (req as RequestWithUser).user?.id;
  if (typeof fromAuth === "string" && fromAuth.length > 0) return fromAuth;

  if (devFallbackEnabled()) {
    const header = req.get(DEV_USER_HEADER);
    if (typeof header === "string" && header.trim().length > 0) {
      return header.trim();
    }
  }

  return null;
}

/**
 * Reads the same id but insists on one, so a route body can treat the user as
 * a given. Stores it on `res.locals` for `requireUserId` to pick up.
 */
export const requireUser: RequestHandler = (req, res, next) => {
  const userId = getUserId(req);

  if (userId === null) {
    next(HttpError.unauthorized("Sign in to use your library."));
    return;
  }

  res.locals["userId"] = userId;
  next();
};

/**
 * Reads back what `requireUser` stored. Throwing rather than returning `null`
 * keeps route handlers free of a branch that cannot happen: reaching a handler
 * mounted behind `requireUser` means the id is there.
 */
export function requireUserId(res: { locals: Record<string, unknown> }): string {
  const userId = res.locals["userId"];

  if (typeof userId !== "string" || userId.length === 0) {
    throw new Error("requireUser must run before requireUserId");
  }

  return userId;
}
