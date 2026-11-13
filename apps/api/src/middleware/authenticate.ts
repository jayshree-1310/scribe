import type { Request, RequestHandler } from "express";
import { verifyAccessToken } from "../lib/jwt.js";
import { logger } from "../lib/logger.js";
import { connectRedis } from "../lib/redis.js";
import { isAccessTokenRevoked } from "../lib/sessions.js";

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
export const authenticate: RequestHandler = async (req, _res, next) => {
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

  if (payload && !(await revoked(payload.sub, payload.issuedAtMs))) {
    (req as RequestWithUser).user = { id: payload.sub };
  }

  next();
};

/**
 * A token issued before the user's sessions were last revoked -- a password
 * change, a reset, "sign out everywhere", deletion -- is refused, though its
 * signature is still good. See `revokeAccessTokens` in `lib/sessions.ts`.
 *
 * If Redis cannot be reached the token is accepted: every route that needs
 * Redis fails on its own anyway, and refusing every signed-in request for a
 * cache outage would take the whole app down to close a fifteen-minute window.
 */
async function revoked(userId: string, issuedAtMs: number): Promise<boolean> {
  try {
    await connectRedis();
    return await isAccessTokenRevoked(userId, issuedAtMs);
  } catch (error) {
    logger.warn({ err: error }, "access-token cut-off not checked");
    return false;
  }
}
