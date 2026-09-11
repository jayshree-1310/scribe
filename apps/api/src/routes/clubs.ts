/**
 * Book club routes.
 *
 * Browsing a club is open -- the list and the detail page are public, and a
 * signed-in caller additionally sees their own membership -- so this router is
 * not placed behind `requireUser`. Everything that writes reads the caller
 * per-handler instead, through `requireUser` as route-level middleware.
 *
 * Route order matters: the literal `/discussions/:id` is declared before
 * `/:slug`, which would otherwise swallow it.
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
  CLUB_ROLES,
  CLUB_SORTS,
  MAX_PAGE_SIZE,
  createClub,
  createDiscussion,
  deleteClub,
  deleteDiscussion,
  getClub,
  joinClub,
  leaveClub,
  listClubs,
  listDiscussions,
  listMembers,
  removeMember,
  setCurrentRead,
  setMemberRole,
  updateClub,
} from "../services/clubs.js";

const router = Router();

/**
 * How many discussions one member may post per window. Generous enough that a
 * lively thread never trips it, low enough that a script cannot flood a club.
 *
 * Keyed by user rather than by address, unlike the auth limiters in
 * `lib/auth-rate-limit.ts`: posting needs a session, so there is a better
 * subject than the IP, and one office behind a single address should not share
 * one posting budget.
 */
const DISCUSSION_LIMIT = 30;

const DISCUSSION_WINDOW_SECONDS = 10 * 60;

function discussionKey(userId: string): string {
  return `clubs:ratelimit:discussion:${userId}`;
}

/**
 * `req.query` values arrive as strings. Coercion lives in the schema so a bad
 * `page=abc` is a 400 with a field message rather than a silent `NaN`.
 */
const listQuerySchema = z.object({
  search: z.string().trim().min(1).max(120).optional(),
  mine: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  sort: z.enum(CLUB_SORTS).default("members"),
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

const idParamSchema = z.object({
  id: z.string().trim().min(1).max(200),
});

const memberParamSchema = idParamSchema.extend({
  userId: z.uuid("That person could not be found."),
});

const discussionIdParamSchema = z.object({
  id: z.uuid("That discussion could not be found."),
});

const clubBodySchema = z.object({
  name: z.string().trim().min(2, "Give the club a name.").max(120),
  description: z.string().trim().max(2000).nullish(),
});

/**
 * Every field optional, but at least one present: an empty PATCH is a caller
 * bug, and answering it with a 200 would hide it.
 */
const clubPatchSchema = clubBodySchema.partial().refine(
  (body) => Object.values(body).some((value) => value !== undefined),
  { message: "Nothing to change." },
);

const roleBodySchema = z.object({ role: z.enum(CLUB_ROLES) });

/**
 * Null clears the club's current read, which is why this is `nullable` rather
 * than `optional` -- "no story" has to be expressible, and an absent key is
 * not the same statement.
 */
const currentReadBodySchema = z.object({
  storyId: z.uuid("That story could not be found.").nullable(),
});

const discussionQuerySchema = z.object({
  parentId: z.uuid("That discussion could not be found.").optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
});

const discussionBodySchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, "Write something before posting.")
    .max(5000, "That post is too long."),
  parentId: z.uuid("That discussion could not be found.").optional(),
});

const memberQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(24),
});

/* Discussions ------------------------------------------------------------ */

// Ahead of `/:slug` and `/:id`, which would otherwise match "discussions".
router.delete("/discussions/:id", requireUser, async (req, res, next) => {
  try {
    const { id } = parseOrThrow(discussionIdParamSchema, req.params);

    await deleteDiscussion(requireUserId(res), id);

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

/* Discovery -------------------------------------------------------------- */

router.get("/", async (req, res, next) => {
  try {
    const query = parseOrThrow(listQuerySchema, req.query);

    const page = await listClubs(
      {
        search: query.search,
        mine: query.mine,
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

router.post("/", requireUser, async (req, res, next) => {
  try {
    const body = parseOrThrow(clubBodySchema, req.body);

    const club = await createClub(requireUserId(res), {
      name: body.name,
      description: body.description,
    });

    res.status(201).json({ club });
  } catch (error) {
    next(error);
  }
});

/* One club --------------------------------------------------------------- */

router.get("/:slug", async (req, res, next) => {
  try {
    const { slug } = parseOrThrow(slugParamSchema, req.params);

    res.json({ club: await getClub(slug, getUserId(req)) });
  } catch (error) {
    next(error);
  }
});

router.patch("/:id", requireUser, async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const body = parseOrThrow(clubPatchSchema, req.body);

    const club = await updateClub(requireUserId(res), id, {
      name: body.name,
      description: body.description,
    });

    res.json({ club });
  } catch (error) {
    next(error);
  }
});

router.delete("/:id", requireUser, async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);

    await deleteClub(requireUserId(res), id);

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

/* Membership ------------------------------------------------------------- */

router.get("/:slug/members", async (req, res, next) => {
  try {
    const { slug } = parseOrThrow(slugParamSchema, req.params);
    const { page, limit } = parseOrThrow(memberQuerySchema, req.query);

    res.json(await listMembers(slug, page, limit));
  } catch (error) {
    next(error);
  }
});

router.post("/:id/join", requireUser, async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);

    const membership = await joinClub(requireUserId(res), id);

    // 200 rather than 201: joining is idempotent, so the response cannot
    // honestly claim to have created something on the second call.
    res.json({ membership });
  } catch (error) {
    next(error);
  }
});

router.delete("/:id/leave", requireUser, async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);

    await leaveClub(requireUserId(res), id);

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.patch("/:id/members/:userId", requireUser, async (req, res, next) => {
  try {
    const { id, userId } = parseOrThrow(memberParamSchema, req.params);
    const { role } = parseOrThrow(roleBodySchema, req.body);

    const member = await setMemberRole(requireUserId(res), id, userId, role);

    res.json({ member });
  } catch (error) {
    next(error);
  }
});

router.delete("/:id/members/:userId", requireUser, async (req, res, next) => {
  try {
    const { id, userId } = parseOrThrow(memberParamSchema, req.params);

    await removeMember(requireUserId(res), id, userId);

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

/* Current read ----------------------------------------------------------- */

router.put("/:id/current-read", requireUser, async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const { storyId } = parseOrThrow(currentReadBodySchema, req.body);

    const club = await setCurrentRead(requireUserId(res), id, storyId);

    res.json({ club });
  } catch (error) {
    next(error);
  }
});

/* Club discussions ------------------------------------------------------- */

router.get("/:slug/discussions", async (req, res, next) => {
  try {
    const { slug } = parseOrThrow(slugParamSchema, req.params);
    const query = parseOrThrow(discussionQuerySchema, req.query);

    res.json(
      await listDiscussions(slug, {
        parentId: query.parentId,
        page: query.page,
        limit: query.limit,
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.post("/:id/discussions", requireUser, async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const body = parseOrThrow(discussionBodySchema, req.body);
    const userId = requireUserId(res);

    const { limited, retryAfter } = await isRateLimited(
      discussionKey(userId),
      DISCUSSION_LIMIT,
    );
    if (limited) {
      throw HttpError.tooManyRequests(
        "You have posted a lot in a short time. Give it a moment and try again.",
        retryAfter || DISCUSSION_WINDOW_SECONDS,
      );
    }

    const discussion = await createDiscussion(userId, id, {
      body: body.body,
      parentId: body.parentId,
    });

    // Charged only once the post succeeded: a rejected post -- not a member,
    // no such club -- should not spend the caller's budget.
    await recordAttempt(discussionKey(userId), DISCUSSION_WINDOW_SECONDS);

    res.status(201).json({ discussion });
  } catch (error) {
    next(error);
  }
});

export default router;
