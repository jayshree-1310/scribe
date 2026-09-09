/**
 * Shelf routes. Every one of these needs a reader, so the whole router sits
 * behind `requireUser` and each handler reads the id back from `res.locals`
 * rather than trusting anything in the request body.
 */

import { Router } from "express";
import { z } from "zod";
import { parseOrThrow } from "../lib/validate.js";
import { requireUser, requireUserId } from "../middleware/current-user.js";
import {
  READING_STATUSES,
  addToLibrary,
  listLibrary,
  removeFromLibrary,
  setReadingStatus,
} from "../services/library.js";

const router = Router();

router.use(requireUser);

const statusSchema = z.enum(READING_STATUSES);

const listQuerySchema = z.object({
  status: z.union([statusSchema, z.literal("ALL")]).default("ALL"),
  search: z.string().trim().min(1).max(120).optional(),
});

const addBodySchema = z.object({
  bookId: z.uuid("That book could not be found."),
  status: statusSchema.default("WANT_TO_READ"),
});

const updateBodySchema = z.object({ status: statusSchema });

const bookParamSchema = z.object({
  bookId: z.uuid("That book could not be found."),
});

router.get("/", async (req, res, next) => {
  try {
    const query = parseOrThrow(listQuerySchema, req.query);

    const view = await listLibrary(requireUserId(res), {
      status: query.status === "ALL" ? undefined : query.status,
      search: query.search,
    });

    res.json(view);
  } catch (error) {
    next(error);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const body = parseOrThrow(addBodySchema, req.body);

    const entry = await addToLibrary(
      requireUserId(res),
      body.bookId,
      body.status,
    );

    res.status(201).json({ entry });
  } catch (error) {
    next(error);
  }
});

router.patch("/:bookId", async (req, res, next) => {
  try {
    const { bookId } = parseOrThrow(bookParamSchema, req.params);
    const { status } = parseOrThrow(updateBodySchema, req.body);

    const entry = await setReadingStatus(requireUserId(res), bookId, status);

    res.json({ entry });
  } catch (error) {
    next(error);
  }
});

router.delete("/:bookId", async (req, res, next) => {
  try {
    const { bookId } = parseOrThrow(bookParamSchema, req.params);

    await removeFromLibrary(requireUserId(res), bookId);

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

export default router;
