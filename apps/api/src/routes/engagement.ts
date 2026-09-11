/**
 * Comment and rating routes.
 *
 * Mounted at `/api` rather than under the stories router, because the resource
 * set spans two top-level paths: a comment is addressed by story when it is
 * created (`/api/stories/:storyId/comments`) and by its own id when it is
 * deleted (`/api/comments/:id`). Splitting those across two routers would put
 * one service behind two files; mounting this one at the root keeps the whole
 * surface in the file named after the service. `app.ts` mounts it after the
 * stories router, which matches none of these paths.
 *
 * Reading is open -- a story's comments and its rating breakdown are public,
 * and a signed-in caller additionally sees their own score -- so this router
 * is not placed behind `requireUser`. Everything that writes takes
 * `requireUser` as route-level middleware instead.
 */

import { Router } from "express";
import { z } from "zod";
import { parseOrThrow } from "../lib/validate.js";
import { HttpError } from "../lib/http-error.js";
import { isRateLimited, recordAttempt } from "../lib/rate-limit.js";
import {
  getUserId,
  requireUser,
  requireUserId,
} from "../middleware/current-user.js";
import {
  COMMENT_MAX_LENGTH,
  MAX_PAGE_SIZE,
  RATING_MAX,
  RATING_MIN,
  createComment,
  deleteComment,
  deleteRating,
  getRatings,
  listComments,
  upsertRating,
} from "../services/engagement.js";

const router = Router();

/**
 * Per *user*, not per IP, for the reason `routes/clubs.ts` gives: a shared
 * office NAT is one IP and many people, and throttling them as one punishes
 * the wrong party. Thirty comments in ten minutes is far above what a reader
 * does and far below what a script wants.
 */
const COMMENT_LIMIT = 30;

const COMMENT_WINDOW_SECONDS = 10 * 60;

function commentKey(userId: string): string {
  return `rl:comment:${userId}`;
}

/**
 * Accepts a slug or an id, so the shape is deliberately loose -- the service
 * decides which of the two it is. The bound keeps a pathological URL from
 * reaching the database.
 */
const storyParamSchema = z.object({
  storyId: z.string().trim().min(1).max(200),
});

const commentIdParamSchema = z.object({
  id: z.uuid("That comment could not be found."),
});

const listQuerySchema = z.object({
  /** A thread id lists that thread's replies; absent lists the threads. */
  parentId: z.uuid().optional(),
  chapterId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
});

/**
 * `.trim()` runs before the length checks, so a body of nothing but whitespace
 * fails `min(1)` rather than being stored as an empty comment.
 */
const commentBodySchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, "Write something before posting.")
    .max(COMMENT_MAX_LENGTH, "That comment is too long."),
  chapterId: z.uuid().optional(),
  parentId: z.uuid().optional(),
});

/**
 * Whole scores only. A half-star average is something the API computes; it is
 * not something a reader may submit, and `Rating.rating` being a `numeric`
 * would otherwise accept 3.7 without complaint.
 */
const ratingBodySchema = z.object({
  rating: z
    .number()
    .int("Rate in whole stars.")
    .min(RATING_MIN, "Rate between 1 and 5 stars.")
    .max(RATING_MAX, "Rate between 1 and 5 stars."),
});

/* Comments --------------------------------------------------------------- */

router.get("/stories/:storyId/comments", async (req, res, next) => {
  try {
    const { storyId } = parseOrThrow(storyParamSchema, req.params);
    const query = parseOrThrow(listQuerySchema, req.query);

    const page = await listComments(
      storyId,
      {
        parentId: query.parentId,
        chapterId: query.chapterId,
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

router.post("/stories/:storyId/comments", requireUser, async (req, res, next) => {
  try {
    const { storyId } = parseOrThrow(storyParamSchema, req.params);
    const body = parseOrThrow(commentBodySchema, req.body);
    const userId = requireUserId(res);

    const { limited, retryAfter } = await isRateLimited(
      commentKey(userId),
      COMMENT_LIMIT,
    );
    if (limited) {
      throw HttpError.tooManyRequests(
        "You have commented a lot in a short time. Give it a moment and try again.",
        retryAfter || COMMENT_WINDOW_SECONDS,
      );
    }

    const comment = await createComment(userId, storyId, {
      content: body.content,
      chapterId: body.chapterId,
      parentId: body.parentId,
    });

    // Charged only once the comment landed: a rejected post -- no such story,
    // no such parent -- should not spend the caller's budget.
    await recordAttempt(commentKey(userId), COMMENT_WINDOW_SECONDS);

    res.status(201).json({ comment });
  } catch (error) {
    next(error);
  }
});

router.delete("/comments/:id", requireUser, async (req, res, next) => {
  try {
    const { id } = parseOrThrow(commentIdParamSchema, req.params);

    await deleteComment(requireUserId(res), id);

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

/* Ratings ---------------------------------------------------------------- */

router.get("/stories/:storyId/ratings", async (req, res, next) => {
  try {
    const { storyId } = parseOrThrow(storyParamSchema, req.params);

    res.json(await getRatings(storyId, getUserId(req)));
  } catch (error) {
    next(error);
  }
});

router.put("/stories/:storyId/rating", requireUser, async (req, res, next) => {
  try {
    const { storyId } = parseOrThrow(storyParamSchema, req.params);
    const body = parseOrThrow(ratingBodySchema, req.body);

    const summary = await upsertRating(
      requireUserId(res),
      storyId,
      body.rating,
    );

    // 200 rather than 201: a rating is upserted, so the response cannot
    // honestly claim to have created something on the second call.
    res.json(summary);
  } catch (error) {
    next(error);
  }
});

router.delete("/stories/:storyId/rating", requireUser, async (req, res, next) => {
  try {
    const { storyId } = parseOrThrow(storyParamSchema, req.params);

    // The refreshed summary rather than a 204: the page that just removed a
    // rating has to redraw the average and the breakdown either way, and this
    // saves it a follow-up request.
    res.json(await deleteRating(requireUserId(res), storyId));
  } catch (error) {
    next(error);
  }
});

export default router;
