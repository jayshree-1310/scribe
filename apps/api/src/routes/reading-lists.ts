/**
 * Reading list routes, mounted at `/api/lists`.
 *
 * Reading is open -- browsing, a reader's public lists and one list's page
 * answer signed out, and a signed-in caller also sees their follow state and
 * their own private lists -- so this router is not behind `requireUser`.
 * Everything that writes takes `requireUser` as route-level middleware.
 *
 * Lists are addressed by slug or id under `/:id`, so this router declares no
 * literal path segment beside it that a list's slug could shadow.
 */

import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../lib/http-error.js";
import { reserveAttempt } from "../lib/rate-limit.js";
import { pageSchema, parseOrThrow } from "../lib/validate.js";
import {
  getUserId,
  requireUser,
  requireUserId,
} from "../middleware/current-user.js";
import {
  DESCRIPTION_MAX_LENGTH,
  LIST_SORTS,
  MAX_PAGE_SIZE,
  NAME_MAX_LENGTH,
  NOTE_MAX_LENGTH,
  addListEntry,
  createReadingList,
  deleteReadingList,
  followList,
  getReadingList,
  listReadingLists,
  removeListEntry,
  unfollowList,
  updateListEntry,
  updateReadingList,
} from "../services/reading-lists.js";

const router = Router();

const listQuerySchema = z.object({
  owner: z.string().trim().min(1).max(60).optional(),
  followed: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  storyId: z.uuid("That story could not be found.").optional(),
  sort: z.enum(LIST_SORTS).default("popular"),
  page: pageSchema,
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(12),
});

/** A slug or an id; the service decides which. */
const idParamSchema = z.object({
  id: z.string().trim().min(1).max(200),
});

const entryParamSchema = z.object({
  id: z.string().trim().min(1).max(200),
  storyId: z.uuid("That story could not be found."),
});

/** An empty note is no note. */
const noteSchema = z
  .string()
  .trim()
  .max(NOTE_MAX_LENGTH, `Keep the note under ${NOTE_MAX_LENGTH} characters.`)
  .nullish()
  .transform((value) => (value ? value : null));

const listBodySchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Give the list a name.")
    .max(NAME_MAX_LENGTH, `Keep the name under ${NAME_MAX_LENGTH} characters.`),
  description: z
    .string()
    .trim()
    .max(DESCRIPTION_MAX_LENGTH, `Keep the description under ${DESCRIPTION_MAX_LENGTH} characters.`)
    .nullish()
    .transform((value) => (value ? value : null)),
  isPublic: z.boolean().optional(),
});

/** Every field optional, but at least one present. */
const listPatchSchema = listBodySchema.partial().refine(
  (body) => Object.values(body).some((value) => value !== undefined),
  { message: "Nothing to change." },
);

const entryBodySchema = z.object({
  storyId: z.uuid("That story could not be found."),
  note: noteSchema,
});

const entryPatchSchema = z.object({ note: noteSchema });

/* Reading ---------------------------------------------------------------- */

router.get("/", async (req, res, next) => {
  try {
    const query = parseOrThrow(listQuerySchema, req.query);

    res.json(
      await listReadingLists(
        {
          owner: query.owner,
          followed: query.followed,
          storyId: query.storyId,
          sort: query.sort,
          page: query.page,
          limit: query.limit,
        },
        getUserId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);

    res.json({ list: await getReadingList(id, getUserId(req)) });
  } catch (error) {
    next(error);
  }
});

/* Lists ------------------------------------------------------------------ */

/**
 * New lists per reader per day. Each public one is a page anybody can find,
 * and the per-reader cap alone would let an account delete and recreate them
 * all day.
 */
const CREATE_LIST_LIMIT = 20;
const CREATE_LIST_WINDOW_SECONDS = 24 * 60 * 60;

router.post("/", requireUser, async (req, res, next) => {
  try {
    const body = parseOrThrow(listBodySchema, req.body);
    const userId = requireUserId(res);

    const attempt = await reserveAttempt(
      `lists:ratelimit:create:${userId}`,
      CREATE_LIST_LIMIT,
      CREATE_LIST_WINDOW_SECONDS,
    );
    if (attempt.limited) {
      throw HttpError.tooManyRequests(
        "You have started a lot of lists today. Try again tomorrow.",
        attempt.retryAfter || CREATE_LIST_WINDOW_SECONDS,
      );
    }

    // Charged only if it lands.
    const list = await createReadingList(userId, body).catch(
      attempt.refundAndRethrow,
    );

    res.status(201).json({ list });
  } catch (error) {
    next(error);
  }
});

router.patch("/:id", requireUser, async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const body = parseOrThrow(listPatchSchema, req.body);

    res.json({ list: await updateReadingList(requireUserId(res), id, body) });
  } catch (error) {
    next(error);
  }
});

router.delete("/:id", requireUser, async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);

    await deleteReadingList(requireUserId(res), id);

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

/* Entries ---------------------------------------------------------------- */

router.post("/:id/entries", requireUser, async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const body = parseOrThrow(entryBodySchema, req.body);

    const entry = await addListEntry(requireUserId(res), id, body.storyId, body.note);

    res.status(201).json({ entry });
  } catch (error) {
    next(error);
  }
});

router.patch("/:id/entries/:storyId", requireUser, async (req, res, next) => {
  try {
    const { id, storyId } = parseOrThrow(entryParamSchema, req.params);
    const { note } = parseOrThrow(entryPatchSchema, req.body);

    res.json({ entry: await updateListEntry(requireUserId(res), id, storyId, note) });
  } catch (error) {
    next(error);
  }
});

router.delete("/:id/entries/:storyId", requireUser, async (req, res, next) => {
  try {
    const { id, storyId } = parseOrThrow(entryParamSchema, req.params);

    await removeListEntry(requireUserId(res), id, storyId);

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

/* Following -------------------------------------------------------------- */

router.post("/:id/follow", requireUser, async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);

    // 200 rather than 201: following is idempotent.
    res.json(await followList(requireUserId(res), id));
  } catch (error) {
    next(error);
  }
});

router.delete("/:id/follow", requireUser, async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);

    res.json(await unfollowList(requireUserId(res), id));
  } catch (error) {
    next(error);
  }
});

export default router;
