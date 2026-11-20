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
import {
  HIGHLIGHT_LIMIT,
  NOTE_LIMIT,
  createHighlight,
  deleteHighlight,
  listHighlights,
  updateHighlight,
} from "../services/highlights.js";

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

/* Highlights and margin notes ------------------------------------------- */

const highlightListQuerySchema = z.object({
  storyId: z.uuid("That story could not be found."),
});

const noteSchema = z
  .string()
  .max(NOTE_LIMIT, `Keep the note under ${NOTE_LIMIT} characters.`)
  .nullable();

/**
 * Offsets into the stored chapter, never the passage itself -- the service
 * cuts the quote out of the chapter, so a highlight can only ever hold the
 * author's words. See the header of `services/highlights.ts`.
 */
const highlightBodySchema = z
  .object({
    chapterId: z.uuid("That chapter could not be found."),
    start: z.coerce.number().int().min(0),
    end: z.coerce.number().int().min(1),
    note: noteSchema.optional(),
  })
  .refine((value) => value.end > value.start, {
    message: "That passage is empty.",
    path: ["end"],
  })
  .refine((value) => value.end - value.start <= HIGHLIGHT_LIMIT, {
    message: "That passage is too long to highlight.",
    path: ["end"],
  });

const highlightUpdateSchema = z.object({ note: noteSchema });

const highlightParamSchema = z.object({
  id: z.uuid("That highlight could not be found."),
});

router.get("/highlights", async (req, res, next) => {
  try {
    const { storyId } = parseOrThrow(highlightListQuerySchema, req.query);

    const highlights = await listHighlights(requireUserId(res), storyId);

    res.json({ highlights });
  } catch (error) {
    next(error);
  }
});

router.post("/highlights", async (req, res, next) => {
  try {
    const body = parseOrThrow(highlightBodySchema, req.body);

    const highlight = await createHighlight(requireUserId(res), body);

    res.status(201).json({ highlight });
  } catch (error) {
    next(error);
  }
});

router.patch("/highlights/:id", async (req, res, next) => {
  try {
    const { id } = parseOrThrow(highlightParamSchema, req.params);
    const { note } = parseOrThrow(highlightUpdateSchema, req.body);

    const highlight = await updateHighlight(requireUserId(res), id, note);

    res.json({ highlight });
  } catch (error) {
    next(error);
  }
});

router.delete("/highlights/:id", async (req, res, next) => {
  try {
    const { id } = parseOrThrow(highlightParamSchema, req.params);

    await deleteHighlight(requireUserId(res), id);

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

export default router;
