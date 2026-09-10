/**
 * Story routes: discovery, one story, and its chapters.
 *
 * All of these are open -- reading does not require a session. Identity still
 * matters when there is one: an author sees their own drafts and unpublished
 * chapters through these same endpoints, so `getUserId` is read per handler
 * rather than the router being placed behind `requireUser`.
 */

import { Router } from "express";
import { z } from "zod";
import { parseOrThrow } from "../lib/validate.js";
import { getUserId } from "../middleware/current-user.js";
import {
  MAX_PAGE_SIZE,
  STORY_SORTS,
  getChapter,
  getRelatedStories,
  getStory,
  listChapters,
  listGenres,
  listStories,
} from "../services/stories.js";

const router = Router();

/**
 * `req.query` values arrive as strings. Coercion lives in the schema so a bad
 * `page=abc` is a 400 with a field message rather than a silent `NaN`.
 */
const listQuerySchema = z.object({
  search: z.string().trim().min(1).max(120).optional(),
  genreId: z.uuid("Not a known genre.").optional(),
  authorId: z.uuid("Not a known author.").optional(),
  sort: z.enum(STORY_SORTS).default("trending"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(12),
});

/**
 * Accepts a slug or an id, so the shape is deliberately loose -- the service
 * decides which of the two it is. The bound keeps a pathological URL from
 * reaching the database.
 */
const slugParamSchema = z.object({
  slug: z.string().trim().min(1).max(200),
});

const chapterParamSchema = slugParamSchema.extend({
  number: z.coerce
    .number("That chapter could not be found.")
    .int("That chapter could not be found.")
    .min(1, "That chapter could not be found."),
});

/* Reference data --------------------------------------------------------- */

// Ahead of `/:slug`, which would otherwise match "genres".
router.get("/genres", async (_req, res, next) => {
  try {
    res.json({ genres: await listGenres() });
  } catch (error) {
    next(error);
  }
});

/* Discovery -------------------------------------------------------------- */

router.get("/", async (req, res, next) => {
  try {
    const query = parseOrThrow(listQuerySchema, req.query);

    const page = await listStories(
      {
        search: query.search,
        genreId: query.genreId,
        authorId: query.authorId,
        sort: query.sort,
        page: query.page,
        limit: query.limit,
      },
      getUserId(req),
    );

    res.json(page);
  } catch (error) {
    next(error);
  }
});

/* One story -------------------------------------------------------------- */

router.get("/:slug", async (req, res, next) => {
  try {
    const { slug } = parseOrThrow(slugParamSchema, req.params);
    res.json({ story: await getStory(slug, getUserId(req)) });
  } catch (error) {
    next(error);
  }
});

router.get("/:slug/related", async (req, res, next) => {
  try {
    const { slug } = parseOrThrow(slugParamSchema, req.params);
    res.json({ stories: await getRelatedStories(slug, getUserId(req)) });
  } catch (error) {
    next(error);
  }
});

/* Chapters --------------------------------------------------------------- */

router.get("/:slug/chapters", async (req, res, next) => {
  try {
    const { slug } = parseOrThrow(slugParamSchema, req.params);
    res.json({ chapters: await listChapters(slug, getUserId(req)) });
  } catch (error) {
    next(error);
  }
});

router.get("/:slug/chapters/:number", async (req, res, next) => {
  try {
    const { slug, number } = parseOrThrow(chapterParamSchema, req.params);
    res.json({ chapter: await getChapter(slug, number, getUserId(req)) });
  } catch (error) {
    next(error);
  }
});

export default router;
