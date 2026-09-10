/**
 * Author routes: the write side of stories and chapters.
 *
 * Mounted at `/api/author` and behind `requireUser` in full -- there is no
 * anonymous authoring, and every handler passes the caller's id to the service
 * so ownership is asserted there rather than trusted here.
 *
 * Chapters and attachments are addressed by their own id (`/chapters/:id`)
 * rather than nested under the story, because the editor already holds those
 * ids and the service resolves the owning story from them anyway.
 */

import { Router } from "express";
import { z } from "zod";
import { parseOrThrow } from "../lib/validate.js";
import { requireUser, requireUserId } from "../middleware/current-user.js";
import { MAX_PAGE_SIZE } from "../services/stories.js";
import {
  MULTIMEDIA_TYPES,
  addMultimedia,
  createChapter,
  createStory,
  deleteChapter,
  deleteStory,
  listMyChapters,
  listMyStories,
  publishChapter,
  publishStory,
  removeMultimedia,
  reorderChapters,
  unpublishChapter,
  unpublishStory,
  updateChapter,
  updateStory,
} from "../services/authoring.js";

const router = Router();

router.use(requireUser);

/* Schemas ---------------------------------------------------------------- */

const idParamSchema = z.object({
  id: z.uuid("That could not be found."),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(24),
});

/** Matches the editor's own `maxLength` bounds, so the form cannot outrun the API. */
const titleSchema = z
  .string()
  .trim()
  .min(1, "Your story needs a title.")
  .max(120, "Use at most 120 characters.");

const descriptionSchema = z
  .string()
  .trim()
  .max(1200, "Use at most 1200 characters.");

const coverUrlSchema = z
  .string()
  .trim()
  .max(2000, "That address is too long.");

const genreIdsSchema = z
  .array(z.uuid("One of those genres no longer exists."))
  .max(8, "Pick at most 8 genres.");

const createStorySchema = z.object({
  title: titleSchema,
  description: descriptionSchema.optional(),
  coverUrl: coverUrlSchema.optional(),
  genreIds: genreIdsSchema.optional(),
  kidsAppropriate: z.boolean().optional(),
  isCompleted: z.boolean().optional(),
});

// Every field optional, but not *all* of them: an empty PATCH is a form that
// sent nothing, and answering 200 to it hides the bug.
const updateStorySchema = createStorySchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Nothing to update.",
  });

const chapterTitleSchema = z
  .string()
  .trim()
  .min(1, "Give this chapter a title.")
  .max(120, "Use at most 120 characters.");

/**
 * Chapter bodies are long-form prose. The cap is generous but real --
 * `app.ts` parses JSON up to 256kb, so anything above that never reaches the
 * validator, and a limit here makes the refusal a field message rather than a
 * 413.
 */
const chapterContentSchema = z
  .string()
  .max(200_000, "That chapter is too long to save in one piece.");

const createChapterSchema = z.object({
  title: chapterTitleSchema,
  content: chapterContentSchema.optional(),
});

const updateChapterSchema = z
  .object({
    title: chapterTitleSchema.optional(),
    content: chapterContentSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "Nothing to update.",
  });

const reorderSchema = z.object({
  chapterIds: z
    .array(z.uuid("That chapter could not be found."))
    .min(1, "List every chapter of this story."),
});

const multimediaSchema = z.object({
  type: z.enum(MULTIMEDIA_TYPES),
  url: z
    .string()
    .trim()
    .min(1, "Where does this attachment live?")
    .max(2000, "That address is too long."),
  displayOrder: z.coerce.number().int().min(0).optional(),
});

/* Stories ---------------------------------------------------------------- */

router.get("/stories", async (req, res, next) => {
  try {
    const { page, limit } = parseOrThrow(listQuerySchema, req.query);

    res.json(await listMyStories(requireUserId(res), page, limit));
  } catch (error) {
    next(error);
  }
});

router.post("/stories", async (req, res, next) => {
  try {
    const body = parseOrThrow(createStorySchema, req.body);

    res.status(201).json({ story: await createStory(requireUserId(res), body) });
  } catch (error) {
    next(error);
  }
});

router.patch("/stories/:id", async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const body = parseOrThrow(updateStorySchema, req.body);

    res.json({ story: await updateStory(requireUserId(res), id, body) });
  } catch (error) {
    next(error);
  }
});

router.delete("/stories/:id", async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);

    await deleteStory(requireUserId(res), id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.post("/stories/:id/publish", async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);

    res.json({ story: await publishStory(requireUserId(res), id) });
  } catch (error) {
    next(error);
  }
});

router.post("/stories/:id/unpublish", async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);

    res.json({ story: await unpublishStory(requireUserId(res), id) });
  } catch (error) {
    next(error);
  }
});

/* Chapters --------------------------------------------------------------- */

// Ahead of the parameterised chapter routes below only for readability -- the
// two families are addressed differently and cannot shadow each other.
router.get("/stories/:id/chapters", async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);

    res.json({ chapters: await listMyChapters(requireUserId(res), id) });
  } catch (error) {
    next(error);
  }
});

router.post("/stories/:id/chapters", async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const body = parseOrThrow(createChapterSchema, req.body);

    res
      .status(201)
      .json({ chapter: await createChapter(requireUserId(res), id, body) });
  } catch (error) {
    next(error);
  }
});

// Before `/stories/:id/chapters` would ever be reached for a POST to
// ".../chapters/reorder"; Express matches on the full path, so the order of
// these two only matters to a reader.
router.post("/stories/:id/chapters/reorder", async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const { chapterIds } = parseOrThrow(reorderSchema, req.body);

    res.json({
      chapters: await reorderChapters(requireUserId(res), id, chapterIds),
    });
  } catch (error) {
    next(error);
  }
});

router.patch("/chapters/:id", async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const body = parseOrThrow(updateChapterSchema, req.body);

    res.json({ chapter: await updateChapter(requireUserId(res), id, body) });
  } catch (error) {
    next(error);
  }
});

/**
 * Answers with the story's remaining chapters rather than 204: the delete
 * renumbers everything after the gap, so the editor's list is stale the moment
 * this returns.
 */
router.delete("/chapters/:id", async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);

    res.json({ chapters: await deleteChapter(requireUserId(res), id) });
  } catch (error) {
    next(error);
  }
});

router.post("/chapters/:id/publish", async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);

    res.json({ chapter: await publishChapter(requireUserId(res), id) });
  } catch (error) {
    next(error);
  }
});

router.post("/chapters/:id/unpublish", async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);

    res.json({ chapter: await unpublishChapter(requireUserId(res), id) });
  } catch (error) {
    next(error);
  }
});

/* Multimedia ------------------------------------------------------------- */

router.post("/chapters/:id/multimedia", async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const body = parseOrThrow(multimediaSchema, req.body);

    res
      .status(201)
      .json({ multimedia: await addMultimedia(requireUserId(res), id, body) });
  } catch (error) {
    next(error);
  }
});

router.delete("/multimedia/:id", async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);

    await removeMultimedia(requireUserId(res), id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

export default router;
