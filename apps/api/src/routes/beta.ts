/**
 * Beta reader routes: an author's invite link and readers, joining through
 * the link, and private feedback. See the header of `services/beta.ts`.
 *
 * Behind `requireUser` in full. Joining needs an account -- a beta reader is
 * a person the author can see and remove -- and reading what they joined goes
 * through the ordinary `/api/stories` endpoints, which know about beta readers
 * (`StoryAccess` in `services/stories.ts`).
 */

import { Router } from "express";
import { z } from "zod";
import { parseOrThrow } from "../lib/validate.js";
import { requireUser, requireUserId } from "../middleware/current-user.js";
import {
  FEEDBACK_LIMIT,
  FEEDBACK_QUOTE_LIMIT,
  createFeedback,
  createLink,
  deleteFeedback,
  getOverview,
  joinBeta,
  leaveBeta,
  listFeedback,
  previewInvite,
  removeReader,
  revokeLink,
  updateFeedback,
} from "../services/beta.js";

const router = Router();

router.use(requireUser);

/* Schemas ---------------------------------------------------------------- */

const storyParamSchema = z.object({
  storyId: z.uuid("That story could not be found."),
});

/** The feedback list takes a slug as well, as the reader page holds one. */
const storyKeyParamSchema = z.object({
  storyId: z.string().trim().min(1).max(200),
});

const readerParamSchema = storyParamSchema.extend({
  userId: z.uuid("That reader could not be found."),
});

/** `newToken` mints 24 base64url characters; anything else names nothing. */
const tokenParamSchema = z.object({
  token: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,64}$/, "That invite link is not valid."),
});

const feedbackParamSchema = z.object({
  id: z.uuid("That feedback could not be found."),
});

const bodySchema = z
  .string()
  .trim()
  .min(1, "Write something first.")
  .max(FEEDBACK_LIMIT, `Keep feedback under ${FEEDBACK_LIMIT} characters.`);

/**
 * A passage is offsets into the stored chapter, never text: the service cuts
 * the quote out of the chapter itself, as it does for a highlight.
 */
const feedbackBodySchema = z
  .object({
    chapterId: z.uuid("That chapter could not be found."),
    body: bodySchema,
    start: z.number().int().min(0).optional(),
    end: z.number().int().min(1).optional(),
  })
  .refine((value) => (value.start === undefined) === (value.end === undefined), {
    message: "That passage is not in this chapter.",
  })
  .refine(
    (value) =>
      value.start === undefined ||
      value.end === undefined ||
      (value.end > value.start && value.end - value.start <= FEEDBACK_QUOTE_LIMIT),
    { message: "That passage is too long to quote." },
  );

const feedbackUpdateSchema = z.object({ body: bodySchema });

/* Author ----------------------------------------------------------------- */

router.get("/stories/:storyId", async (req, res, next) => {
  try {
    const { storyId } = parseOrThrow(storyParamSchema, req.params);
    res.json(await getOverview(requireUserId(res), storyId));
  } catch (error) {
    next(error);
  }
});

router.post("/stories/:storyId/link", async (req, res, next) => {
  try {
    const { storyId } = parseOrThrow(storyParamSchema, req.params);
    res.status(201).json({ link: await createLink(requireUserId(res), storyId) });
  } catch (error) {
    next(error);
  }
});

router.delete("/stories/:storyId/link", async (req, res, next) => {
  try {
    const { storyId } = parseOrThrow(storyParamSchema, req.params);
    await revokeLink(requireUserId(res), storyId);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.delete("/stories/:storyId/readers/:userId", async (req, res, next) => {
  try {
    const { storyId, userId } = parseOrThrow(readerParamSchema, req.params);
    await removeReader(requireUserId(res), storyId, userId);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

/* Readers ---------------------------------------------------------------- */

router.get("/invites/:token", async (req, res, next) => {
  try {
    const { token } = parseOrThrow(tokenParamSchema, req.params);
    res.json(await previewInvite(token, requireUserId(res)));
  } catch (error) {
    next(error);
  }
});

router.post("/invites/:token/join", async (req, res, next) => {
  try {
    const { token } = parseOrThrow(tokenParamSchema, req.params);
    res.json(await joinBeta(token, requireUserId(res)));
  } catch (error) {
    next(error);
  }
});

router.delete("/stories/:storyId/membership", async (req, res, next) => {
  try {
    const { storyId } = parseOrThrow(storyParamSchema, req.params);
    await leaveBeta(requireUserId(res), storyId);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

/* Feedback --------------------------------------------------------------- */

router.get("/stories/:storyId/feedback", async (req, res, next) => {
  try {
    const { storyId } = parseOrThrow(storyKeyParamSchema, req.params);
    res.json({ feedback: await listFeedback(requireUserId(res), storyId) });
  } catch (error) {
    next(error);
  }
});

router.post("/feedback", async (req, res, next) => {
  try {
    const body = parseOrThrow(feedbackBodySchema, req.body);
    res.status(201).json({ feedback: await createFeedback(requireUserId(res), body) });
  } catch (error) {
    next(error);
  }
});

router.patch("/feedback/:id", async (req, res, next) => {
  try {
    const { id } = parseOrThrow(feedbackParamSchema, req.params);
    const { body } = parseOrThrow(feedbackUpdateSchema, req.body);
    res.json({ feedback: await updateFeedback(requireUserId(res), id, body) });
  } catch (error) {
    next(error);
  }
});

router.delete("/feedback/:id", async (req, res, next) => {
  try {
    const { id } = parseOrThrow(feedbackParamSchema, req.params);
    await deleteFeedback(requireUserId(res), id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

export default router;
