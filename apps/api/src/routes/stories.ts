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
import { readThrough } from "../lib/read-cache.js";
import { pageSchema, parseOrThrow } from "../lib/validate.js";
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
  seesPublicView,
} from "../services/stories.js";

const router = Router();

/**
 * `load` for this caller, through the shared read cache when the caller sees
 * what an anonymous reader sees.
 *
 * The cached copy is always computed as the anonymous reader, so whoever
 * fills it cannot leak a draft into it; an author is served `load` with their
 * own id, uncached. See `seesPublicView` for why that split is exact, and
 * `lib/read-cache.ts` for how stale a shared copy can be.
 */
async function forViewer<T>(
  req: Request,
  key: string,
  load: (viewerId: string | null) => Promise<T>,
): Promise<T> {
  const viewerId = getUserId(req);
  if (await seesPublicView(viewerId)) {
    return readThrough(`stories:${key}`, () => load(null));
  }
  return load(viewerId);
}

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
  });
}

/**
 * The header the web client's product tour sends while it is on screen.
 *
 * The tour opens a story and one of its chapters to show those pages off.
 * That is a demonstration, not a reading: recorded, it would count a chapter
 * the reader never chose toward their reader level and badges, and a view and
 * a read toward some author's analytics -- all for a brand-new account that
 * has not read anything yet.
 *
 * Trusting a client header is safe here in a way it would not be for anything
 * that grants: all it can do is withhold a count of the caller's own visit,
 * which the caller could equally withhold by not making the request.
 */
export const TOUR_PREVIEW_HEADER = "x-scribe-tour";

function isTourPreview(req: Request): boolean {
  return req.get(TOUR_PREVIEW_HEADER) === "1";
}

/**
 * Whether this read is of something not yet public: a draft story, or an
 * unpublished chapter. Only its author and its beta readers can make one.
 * The author's own visit is already left out by the recording SQL; a beta
 * reader's is left out here, so a preview read counts toward neither the
 * author's analytics nor the reader's badges -- the same reasoning as the
 * tour's.
 */
function isUnpublishedRead(publishedAt: string | null): boolean {
  return publishedAt === null;
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
  page: pageSchema,
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
    res.json({ genres: await readThrough("stories:genres", listGenres) });
  } catch (error) {
    next(error);
  }
});

/* Discovery -------------------------------------------------------------- */

router.get("/", async (req, res, next) => {
  try {
    const query = parseOrThrow(listQuerySchema, req.query);

    const filters = {
      search: query.search,
      genreId: query.genreId,
      authorId: query.authorId,
      kidsAppropriate: query.kidsAppropriate,
      sort: query.sort,
      page: query.page,
      limit: query.limit,
    };
    // Keyed on the parsed query, so `?page=1` and no page share an entry.
    const page = await forViewer(req, `list:${JSON.stringify(filters)}`, (viewerId) =>
      listStories(filters, viewerId),
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
    const story = await forViewer(req, `one:${slug}`, (viewerId) => getStory(slug, viewerId));

    /**
     * After the story resolved, so a view is only recorded for a story the
     * caller could actually see -- and never awaited: `recordStoryView`
     * returns `void` by design, so this line cannot delay the response or
     * turn a counter's failure into a failed read.
     */
    if (!isTourPreview(req) && !isUnpublishedRead(story.listedAt)) {
      recordStoryView(story.id, visitor(req));
    }

    res.json({ story });
  } catch (error) {
    next(error);
  }
});

router.get("/:slug/related", async (req, res, next) => {
  try {
    const { slug } = parseOrThrow(slugParamSchema, req.params);
    res.json({
      stories: await forViewer(req, `related:${slug}`, (viewerId) =>
        getRelatedStories(slug, viewerId),
      ),
    });
  } catch (error) {
    next(error);
  }
});

/* Chapters --------------------------------------------------------------- */

router.get("/:slug/chapters", async (req, res, next) => {
  try {
    const { slug } = parseOrThrow(slugParamSchema, req.params);
    res.json({
      chapters: await forViewer(req, `chapters:${slug}`, (viewerId) =>
        listChapters(slug, viewerId),
      ),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Not cached, unlike the reads above: a chapter carries a live like count and
 * the caller's own `likedByMe`, and a reader who likes a chapter and reloads
 * should see both move.
 */
router.get("/:slug/chapters/:number", async (req, res, next) => {
  try {
    const { slug, number } = parseOrThrow(chapterParamSchema, req.params);
    const chapter = await getChapter(slug, number, getUserId(req));

    // The reader endpoint: fetching a chapter's body is the closest thing to
    // "somebody read this" the API can observe. See `engagement.ChapterRead`.
    // Not for the product tour, which is showing the reader off rather than
    // reading -- see `TOUR_PREVIEW_HEADER`.
    if (!isTourPreview(req) && !isUnpublishedRead(chapter.publishedAt)) {
      recordChapterRead(chapter.id, visitor(req));
    }

    res.json({ chapter });
  } catch (error) {
    next(error);
  }
});

export default router;
