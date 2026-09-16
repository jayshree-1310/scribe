/**
 * Author analytics routes.
 *
 * Mounted at `/api/author` alongside `routes/authoring.ts` -- two routers, one
 * prefix, the same arrangement `auth.ts` and `auth-security.ts` have. Split
 * out rather than added to the authoring router because these read an event
 * log and that one writes stories: one prefix does not mean one file.
 *
 * Behind `requireUser` in full. There is no such thing as somebody else's
 * analytics: every handler reads the caller from `requireUserId(res)` and the
 * service filters on it, so no id in a query string can widen the answer.
 */

import { Router } from "express";
import { z } from "zod";
import { parseOrThrow } from "../lib/validate.js";
import { requireUser, requireUserId } from "../middleware/current-user.js";
import {
  ANALYTICS_RANGES,
  getAuthorOverview,
  getStoryAnalytics,
} from "../services/analytics.js";

const router = Router();

router.use(requireUser);

/**
 * The three windows the page offers. An enum rather than a day count, so a
 * caller cannot ask for a series with ten thousand points in it.
 */
const rangeQuerySchema = z.object({
  range: z.enum(ANALYTICS_RANGES).default("30d"),
});

const storyParamSchema = z.object({
  id: z.uuid("That story could not be found."),
});

router.get("/analytics", async (req, res, next) => {
  try {
    const { range } = parseOrThrow(rangeQuerySchema, req.query);

    res.json(await getAuthorOverview(requireUserId(res), range));
  } catch (error) {
    next(error);
  }
});

router.get("/analytics/stories/:id", async (req, res, next) => {
  try {
    const { id } = parseOrThrow(storyParamSchema, req.params);
    const { range } = parseOrThrow(rangeQuerySchema, req.query);

    res.json(await getStoryAnalytics(requireUserId(res), id, range));
  } catch (error) {
    next(error);
  }
});

export default router;
