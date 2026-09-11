/**
 * Reading progress routes. A position belongs to a reader, so the whole router
 * sits behind `requireUser` and each handler reads the id back from
 * `res.locals` rather than trusting anything in the request body.
 */

import { Router } from "express";
import { z } from "zod";
import { parseOrThrow } from "../lib/validate.js";
import { requireUser, requireUserId } from "../middleware/current-user.js";
import {
  MAX_CONTINUE_LIMIT,
  clearProgress,
  getProgress,
  listContinueReading,
  recordProgress,
} from "../services/reading.js";

const router = Router();

router.use(requireUser);

const progressBodySchema = z.object({
  storyId: z.uuid("That story could not be found."),
  chapterId: z.uuid("That chapter could not be found."),
  /**
   * A character offset into the chapter. Unbounded above on purpose — the
   * service clamps it to the chapter's real length, which only it knows.
   */
  offset: z.coerce.number().int().min(0).default(0),
});

const continueQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_CONTINUE_LIMIT).default(6),
});

const storyParamSchema = z.object({
  storyId: z.uuid("That story could not be found."),
});

router.put("/progress", async (req, res, next) => {
  try {
    const body = parseOrThrow(progressBodySchema, req.body);

    const saved = await recordProgress(requireUserId(res), body);

    res.json(saved);
  } catch (error) {
    next(error);
  }
});

router.get("/continue", async (req, res, next) => {
  try {
    const { limit } = parseOrThrow(continueQuerySchema, req.query);

    const entries = await listContinueReading(requireUserId(res), limit);

    res.json({ entries });
  } catch (error) {
    next(error);
  }
});

router.get("/progress/:storyId", async (req, res, next) => {
  try {
    const { storyId } = parseOrThrow(storyParamSchema, req.params);

    const progress = await getProgress(requireUserId(res), storyId);

    // Null, not 404: "nothing saved yet" is an answer the reader page asks for
    // on every story it opens. See the service's own comment.
    res.json({ progress });
  } catch (error) {
    next(error);
  }
});

router.delete("/progress/:storyId", async (req, res, next) => {
  try {
    const { storyId } = parseOrThrow(storyParamSchema, req.params);

    await clearProgress(requireUserId(res), storyId);

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

export default router;
