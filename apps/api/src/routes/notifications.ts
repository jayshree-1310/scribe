/**
 * Notification routes.
 *
 * Every one of them is about the caller and nobody else -- there is no path
 * here that names a user -- so the whole router sits behind `requireUser`
 * rather than repeating it per handler. A notification addressed to somebody
 * else is not merely forbidden, it is invisible: the service scopes every read
 * and every write to `requireUserId(res)`, and an id that is not yours 404s.
 *
 * Mounted under one prefix, unlike `routes/engagement.ts` and
 * `routes/gamification.ts`, because these three paths really are one prefix.
 */

import { Router } from "express";
import { z } from "zod";
import { parseOrThrow } from "../lib/validate.js";
import { requireUser, requireUserId } from "../middleware/current-user.js";
import {
  MAX_PAGE_SIZE,
  listNotifications,
  markAllRead,
  markRead,
} from "../services/notifications.js";

const router = Router();

router.use(requireUser);

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  /**
   * Twenty is what the bell's dropdown draws without scrolling forever; the
   * ceiling is half the other lists' because a notification row is taller than
   * a comment and nothing paginates through them in bulk.
   */
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
  /**
   * `?unread=true` narrows the list. Coerced from the string a query string
   * carries rather than `z.coerce.boolean()`, which would read "false" as
   * true -- every non-empty string is truthy.
   */
  unread: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});

const idParamSchema = z.object({
  id: z.uuid("That notification could not be found."),
});

router.get("/", async (req, res, next) => {
  try {
    const query = parseOrThrow(listQuerySchema, req.query);

    res.json(
      await listNotifications(requireUserId(res), {
        page: query.page,
        limit: query.limit,
        unreadOnly: query.unread,
      }),
    );
  } catch (error) {
    next(error);
  }
});

/**
 * Both write routes answer with the fresh unread count rather than 204: the
 * only thing the client redraws afterwards is the bell, and this request has
 * already touched the number it needs.
 */
router.post("/:id/read", async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);

    res.json(await markRead(requireUserId(res), id));
  } catch (error) {
    next(error);
  }
});

router.post("/read-all", async (_req, res, next) => {
  try {
    res.json(await markAllRead(requireUserId(res)));
  } catch (error) {
    next(error);
  }
});

export default router;
