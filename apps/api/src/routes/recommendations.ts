/**
 * What to read next, and who to follow.
 *
 * Both answers are about one caller, so the whole router sits behind
 * `requireUser` and each handler reads the id back from `res.locals`. There is
 * no anonymous variant: a recommendation with no reader to be for is the
 * trending list, which `/api/stories?sort=trending` already serves.
 */

import { Router } from "express";
import { z } from "zod";
import { parseOrThrow } from "../lib/validate.js";
import { requireUser, requireUserId } from "../middleware/current-user.js";
import {
  MAX_AUTHOR_SUGGESTIONS,
  MAX_RECOMMENDATIONS,
  listRecommendations,
  suggestAuthors,
} from "../services/recommendations.js";

const router = Router();

router.use(requireUser);

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_RECOMMENDATIONS).default(12),
});

const authorQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_AUTHOR_SUGGESTIONS).default(12),
});

/**
 * Registered before the bare path below because Express matches in order and
 * `/authors` would otherwise never be reached -- it would not, in fact, since
 * the other route is `/` exactly, but the order is the property worth keeping
 * rather than the coincidence.
 */
router.get("/authors", async (req, res, next) => {
  try {
    const { limit } = parseOrThrow(authorQuerySchema, req.query);

    res.json({ authors: await suggestAuthors(requireUserId(res), limit) });
  } catch (error) {
    next(error);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const { limit } = parseOrThrow(listQuerySchema, req.query);

    res.json(await listRecommendations(requireUserId(res), limit));
  } catch (error) {
    next(error);
  }
});

export default router;
