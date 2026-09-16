/**
 * Story routes: discovery, one story, and its chapters.
 *
 * All of these are open -- reading does not require a session. Identity still
 * matters when there is one: an author sees their own drafts and unpublished
 * chapters through these same endpoints, so `getUserId` is read per handler
 * rather than the router being placed behind `requireUser`.
 */

import type { Request } from "express";
import { Router } from "express";
import { z } from "zod";
import { parseOrThrow } from "../lib/validate.js";
import { getUserId } from "../middleware/current-user.js";
import {
  recordChapterRead,
  recordStoryView,
  visitorFor,
} from "../services/analytics.js";
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
 * Who the analytics log should dedupe this request by.
 *
 * Built here because only the request carries the address and user agent an
 * anonymous visitor is identified by; `services/analytics.ts` decides what to
 * do with them.
 */
function visitor(req: Request) {
  return visitorFor({
    userId: getUserId(req),
    ip: req.ip,
    userAgent: req.get("user-agent"),
  });
}

/**
 * `req.query` values arrive as strings. Coercion lives in the schema so a bad
 * `page=abc` is a 400 with a field message rather than a silent `NaN`.
 */
const listQuerySchema = z.object({
  search: z.string().trim().min(1).max(120).optional(),
  genreId: z.uuid("Not a known genre.").optional(),
  authorId: z.uuid("Not a known author.").optional(),
  /** One-way narrowing flag; see the same field in `routes/books.ts`. */
  kidsAppropriate: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
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
        kidsAppropriate: query.kidsAppropriate,
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
    const story = await getStory(slug, getUserId(req));

    /**
     * After the story resolved, so a view is only recorded for a story the
     * caller could actually see -- and never awaited: `recordStoryView`
     * returns `void` by design, so this line cannot delay the response or
     * turn a counter's failure into a failed read.
     */
    recordStoryView(story.id, visitor(req));

    res.json({ story });
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
    const chapter = await getChapter(slug, number, getUserId(req));

    // The reader endpoint: fetching a chapter's body is the closest thing to
    // "somebody read this" the API can observe. See `engagement.ChapterRead`.
    recordChapterRead(chapter.id, visitor(req));

    res.json({ chapter });
  } catch (error) {
    next(error);
  }
});

export default router;
