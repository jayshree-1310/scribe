/**
 * The signed-in reader's preferences.
 *
 * A second router on `/api/account`, matching none of the paths in
 * `routes/account.ts` -- the same arrangement `auth-security.ts` has beside
 * `auth.ts`, and for the same reason: these live under the account prefix
 * because they belong to the caller's own account, but they are a different
 * subject with a different service behind them, and folding them into that
 * file would make the shorter of the two routers harder to read.
 *
 * Every route needs a user, so the whole router sits behind `requireUser`.
 */

import { Router } from "express";
import { z } from "zod";
import { parseOrThrow } from "../lib/validate.js";
import { requireUser, requireUserId } from "../middleware/current-user.js";
import { NOTIFICATION_TYPES } from "../services/notifications.js";
import {
  CONTENT_LENGTHS,
  MAX_PREFERRED_GENRES,
  getPreferences,
  updatePreferences,
} from "../services/preferences.js";

const router = Router();

router.use(requireUser);

/**
 * Every field is optional and a missing one is left alone, while a field that
 * *is* present replaces what was there -- `genreIds: []` really does mean "no
 * genres". See the header of `services/preferences.ts` for why a set is
 * replaced rather than merged.
 *
 * The genre cap is checked here as well as in the service: this one produces
 * a field message before a round trip, and the service's protects the other
 * callers it will eventually have.
 */
const updateSchema = z
  .object({
    genreIds: z
      .array(z.uuid("Not a known genre."))
      .max(MAX_PREFERRED_GENRES, `Pick at most ${MAX_PREFERRED_GENRES} genres.`)
      .optional(),
    contentLength: z.enum(CONTENT_LENGTHS).optional(),
    mutedNotificationTypes: z.array(z.enum(NOTIFICATION_TYPES)).optional(),
    onboardingComplete: z.boolean().optional(),
  })
  // An empty body is a no-op the caller almost certainly did not mean, and
  // answering 200 to it hides a broken form. The same rule `PATCH
  // /api/account/me` applies.
  .refine((value) => Object.keys(value).length > 0, {
    message: "Nothing to update.",
  });

router.get("/preferences", async (_req, res, next) => {
  try {
    res.json({ preferences: await getPreferences(requireUserId(res)) });
  } catch (error) {
    next(error);
  }
});

/**
 * `PUT` rather than `PATCH`, although the body is partial: what it replaces
 * are the two sets, and "PUT these genres" is what the onboarding step and the
 * settings form both mean. The scalars beside them are along for the ride.
 */
router.put("/preferences", async (req, res, next) => {
  try {
    const body = parseOrThrow(updateSchema, req.body);

    res.json({
      preferences: await updatePreferences(requireUserId(res), body),
    });
  } catch (error) {
    next(error);
  }
});

export default router;
