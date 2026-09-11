/**
 * Broadcast channel routes.
 *
 * Reading a channel is open -- the list, the detail page and the post feed are
 * public, and a signed-in caller additionally sees their own subscription
 * state -- so this router is not placed behind `requireUser`. Everything that
 * writes takes `requireUser` as route-level middleware instead.
 *
 * Route order matters: the literal `/posts/:id` routes are declared before
 * `/:slug` and `/:id`, which would otherwise swallow them.
 */

import { Router } from "express";
import { z } from "zod";
import { parseOrThrow } from "../lib/validate.js";
import {
  getUserId,
  requireUser,
  requireUserId,
} from "../middleware/current-user.js";
import {
  CHANNEL_SORTS,
  MAX_PAGE_SIZE,
  createChannel,
  createPost,
  deleteChannel,
  deletePost,
  getChannel,
  listChannels,
  listPosts,
  subscribe,
  unsubscribe,
  updateChannel,
  updatePost,
} from "../services/channels.js";

const router = Router();

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
  subscribed: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  sort: z.enum(CHANNEL_SORTS).default("subscribers"),
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

const postIdParamSchema = z.object({
  id: z.uuid("That post could not be found."),
});

const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(10),
});

const channelBodySchema = z.object({
  name: z.string().trim().min(2, "Give the channel a name.").max(120),
  description: z.string().trim().max(2000).nullish(),
});

/**
 * Every field optional, but at least one present: an empty PATCH is a caller
 * bug, and answering it with a 200 would hide it.
 */
const channelPatchSchema = channelBodySchema.partial().refine(
  (body) => Object.values(body).some((value) => value !== undefined),
  { message: "Nothing to change." },
);

const postBodySchema = z.object({
  title: z.string().trim().min(1, "Give the post a title.").max(200),
  content: z
    .string()
    .trim()
    .min(1, "Write something before posting.")
    .max(20000, "That post is too long."),
});

const postPatchSchema = postBodySchema.partial().refine(
  (body) => Object.values(body).some((value) => value !== undefined),
  { message: "Nothing to change." },
);

/* Posts by id ------------------------------------------------------------ */

// Ahead of `/:slug` and `/:id`, which would otherwise match "posts".
router.patch("/posts/:id", requireUser, async (req, res, next) => {
  try {
    const { id } = parseOrThrow(postIdParamSchema, req.params);
    const body = parseOrThrow(postPatchSchema, req.body);

    const post = await updatePost(requireUserId(res), id, {
      title: body.title,
      content: body.content,
    });

    res.json({ post });
  } catch (error) {
    next(error);
  }
});

router.delete("/posts/:id", requireUser, async (req, res, next) => {
  try {
    const { id } = parseOrThrow(postIdParamSchema, req.params);

    await deletePost(requireUserId(res), id);

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

/* Discovery -------------------------------------------------------------- */

router.get("/", async (req, res, next) => {
  try {
    const query = parseOrThrow(listQuerySchema, req.query);

    const page = await listChannels(
      {
        search: query.search,
        mine: query.mine,
        subscribed: query.subscribed,
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
    const body = parseOrThrow(channelBodySchema, req.body);

    const channel = await createChannel(requireUserId(res), {
      name: body.name,
      description: body.description,
    });

    res.status(201).json({ channel });
  } catch (error) {
    next(error);
  }
});

/* One channel ------------------------------------------------------------ */

router.get("/:slug", async (req, res, next) => {
  try {
    const { slug } = parseOrThrow(slugParamSchema, req.params);

    res.json({ channel: await getChannel(slug, getUserId(req)) });
  } catch (error) {
    next(error);
  }
});

router.patch("/:id", requireUser, async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const body = parseOrThrow(channelPatchSchema, req.body);

    const channel = await updateChannel(requireUserId(res), id, {
      name: body.name,
      description: body.description,
    });

    res.json({ channel });
  } catch (error) {
    next(error);
  }
});

router.delete("/:id", requireUser, async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);

    await deleteChannel(requireUserId(res), id);

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

/* Subscriptions ---------------------------------------------------------- */

router.post("/:id/subscribe", requireUser, async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);

    const subscription = await subscribe(requireUserId(res), id);

    // 200 rather than 201: subscribing is idempotent, so the response cannot
    // honestly claim to have created something on the second call.
    res.json(subscription);
  } catch (error) {
    next(error);
  }
});

router.delete("/:id/subscribe", requireUser, async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);

    await unsubscribe(requireUserId(res), id);

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

/* Posts ------------------------------------------------------------------ */

router.get("/:slug/posts", async (req, res, next) => {
  try {
    const { slug } = parseOrThrow(slugParamSchema, req.params);
    const { page, limit } = parseOrThrow(pageQuerySchema, req.query);

    res.json(await listPosts(slug, page, limit));
  } catch (error) {
    next(error);
  }
});

router.post("/:id/posts", requireUser, async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const body = parseOrThrow(postBodySchema, req.body);

    const post = await createPost(requireUserId(res), id, {
      title: body.title,
      content: body.content,
    });

    res.status(201).json({ post });
  } catch (error) {
    next(error);
  }
});

export default router;
