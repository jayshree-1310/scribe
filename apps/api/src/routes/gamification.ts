/**
 * Badge routes.
 *
 * Mounted at the root rather than under one prefix, because the two paths sit
 * under different ones: `/api/badges` is the caller's own collection and
 * `/api/users/:username/badges` is somebody else's. The same arrangement
 * `routes/engagement.ts` has, and for the same reason -- a router is one
 * subject, not one prefix. Registered after `routes/users.ts`, which matches
 * neither path.
 *
 * Only the first needs a session, so `requireUser` is route-level middleware
 * rather than a `router.use`.
 */

import { Router } from "express";
import { z } from "zod";
import { parseOrThrow } from "../lib/validate.js";
import { requireUser, requireUserId } from "../middleware/current-user.js";
import { getMyBadges, getUserBadges } from "../services/gamification.js";

const router = Router();

/**
 * The same bound `routes/users.ts` puts on a handle, and deliberately not
 * `usernameSchema`: a lookup must not turn a name it would refuse to mint into
 * a 400, because an unknown handle is a 404 whatever its shape.
 */
const usernameParamSchema = z.object({
  username: z.string().trim().min(1).max(200),
});

router.get("/badges", requireUser, async (_req, res, next) => {
  try {
    res.json(await getMyBadges(requireUserId(res)));
  } catch (error) {
    next(error);
  }
});

router.get("/users/:username/badges", async (req, res, next) => {
  try {
    const { username } = parseOrThrow(usernameParamSchema, req.params);

    res.json(await getUserBadges(username));
  } catch (error) {
    next(error);
  }
});

export default router;
