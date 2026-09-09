import type { Request, RequestHandler } from "express";
import { verifyAccessToken } from "../lib/jwt.js";

/** Shape this middleware attaches, and that `current-user.ts` reads back. */
export interface RequestWithUser extends Request {
  user?: { id: string } | undefined;
}

/**
 * Identifies the caller from a bearer access token, when there is one.
 *
 * Deliberately never rejects: routes that work either way — browsing the
 * catalogue while signed out, say — need to see an anonymous request rather
 * than a 401, and `requireUser` is what insists on an identity. A malformed or
 * expired token therefore leaves the request anonymous, which is the same
 * outcome as sending nothing and keeps the two indistinguishable to a prober.
 *
 * Mounted before the routers so every route sees the same identity, and so no
 * individual route can forget to look.
 */
export const authenticate: RequestHandler = (req, _res, next) => {
  const header = req.get("authorization");

  if (!header) {
    next();
    return;
  }

  /**
   * `Bearer <token>`, case-insensitive per RFC 6750, and only that: accepting
   * a bare token would let a stray header shape through.
   */
  const match = /^Bearer (.+)$/i.exec(header.trim());

  if (!match) {
    next();
    return;
  }

  const payload = verifyAccessToken(match[1]!);

  if (payload) {
    (req as RequestWithUser).user = { id: payload.sub };
  }

  next();
};
