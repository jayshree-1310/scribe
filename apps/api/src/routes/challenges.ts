/**
 * Writing challenge routes.
 *
 * Browsing is open -- the list, the detail page and the leaderboard are all
 * public, and a signed-in caller additionally sees their own entry -- so this
 * router is not placed behind `requireUser`. Everything that writes takes
 * `requireUser` as route-level middleware and reads the caller from
 * `requireUserId(res)`; nothing takes an identity from a body.
 *
 * Route order matters: the literal `/entries/:id` is declared before `/:slug`,
 * which would otherwise swallow it.
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
  MAX_PAGE_SIZE,
  createChallenge,
  enterChallenge,
  getChallenge,
  listChallenges,
  listLeaderboard,
  updateChallenge,
  updateEntry,
  withdrawEntry,
} from "../services/challenges.js";

const router = Router();

/**
 * Entries one caller may create per window. Keyed by *user* rather than by
 * address, for the reason `routes/clubs.ts` gives: entering needs a session,
 * so there is a better subject than the IP.
 *
 * Low, because the honest number is low: there are a handful of challenges
 * open at once and one entry each. It exists to stop a script taking a place
 * in every challenge on the platform, not to pace a person.
 */
const ENTER_LIMIT = 20;

const ENTER_WINDOW_SECONDS = 10 * 60;

function enterKey(userId: string): string {
  return `rl:challenge-entry:${userId}`;
}

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

const entryIdParamSchema = z.object({
  id: z.uuid("That entry could not be found."),
});

const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
});

/**
 * `storyId` and `note` are nullable rather than merely optional: clearing
 * either has to be expressible, and an absent key is a different statement --
 * "leave it alone".
 */
const entryBodySchema = z
  .object({
    storyId: z.uuid("That story could not be found.").nullable().optional(),
    note: z.string().trim().max(500, "That note is too long.").nullable().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "Nothing to change.",
  });

/** ISO-8601 instants; the service is what checks they make a window. */
const challengeBodySchema = z.object({
  title: z.string().trim().min(3, "Give the challenge a title.").max(160),
  prompt: z.string().trim().min(3, "Give writers a brief.").max(500),
  description: z.string().trim().max(4000).nullish(),
  wordTarget: z.coerce.number().int().min(1).max(1_000_000).nullish(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
});

/**
 * Every field optional, but at least one present: an empty PATCH is a caller
 * bug, and answering it with a 200 would hide it.
 */
const challengePatchSchema = challengeBodySchema.partial().refine(
  (body) => Object.values(body).some((value) => value !== undefined),
  { message: "Nothing to change." },
);

/* Entries ---------------------------------------------------------------- */

// Ahead of `/:slug` and `/:id`, which would otherwise match "entries".
router.put("/entries/:id", requireUser, async (req, res, next) => {
  try {
    const { id } = parseOrThrow(entryIdParamSchema, req.params);
    const body = parseOrThrow(entryBodySchema, req.body);

    const entry = await updateEntry(requireUserId(res), id, {
      storyId: body.storyId,
      note: body.note,
    });

    res.json({ entry });
  } catch (error) {
    next(error);
  }
});

router.delete("/entries/:id", requireUser, async (req, res, next) => {
  try {
    const { id } = parseOrThrow(entryIdParamSchema, req.params);

    await withdrawEntry(requireUserId(res), id);

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

/* Discovery -------------------------------------------------------------- */

router.get("/", async (_req, res, next) => {
  try {
    res.json(await listChallenges());
  } catch (error) {
    next(error);
  }
});

router.post("/", requireUser, async (req, res, next) => {
  try {
    const body = parseOrThrow(challengeBodySchema, req.body);

    const challenge = await createChallenge(requireUserId(res), {
      title: body.title,
      prompt: body.prompt,
      description: body.description,
      wordTarget: body.wordTarget,
      startsAt: body.startsAt,
      endsAt: body.endsAt,
    });

    res.status(201).json({ challenge });
  } catch (error) {
    next(error);
  }
});

/* One challenge ---------------------------------------------------------- */

router.get("/:slug", async (req, res, next) => {
  try {
    const { slug } = parseOrThrow(slugParamSchema, req.params);

    res.json({ challenge: await getChallenge(slug, getUserId(req)) });
  } catch (error) {
    next(error);
  }
});

router.patch("/:id", requireUser, async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const body = parseOrThrow(challengePatchSchema, req.body);

    const challenge = await updateChallenge(requireUserId(res), id, {
      title: body.title,
      prompt: body.prompt,
      description: body.description,
      wordTarget: body.wordTarget,
      startsAt: body.startsAt,
      endsAt: body.endsAt,
    });

    res.json({ challenge });
  } catch (error) {
    next(error);
  }
});

router.get("/:slug/leaderboard", async (req, res, next) => {
  try {
    const { slug } = parseOrThrow(slugParamSchema, req.params);
    const query = parseOrThrow(pageQuerySchema, req.query);

    res.json(await listLeaderboard(slug, query));
  } catch (error) {
    next(error);
  }
});

router.post("/:id/enter", requireUser, async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const userId = requireUserId(res);

    const { limited, retryAfter } = await isRateLimited(
      enterKey(userId),
      ENTER_LIMIT,
    );
    if (limited) {
      throw HttpError.tooManyRequests(
        "You have entered a lot of challenges in a short time. Give it a moment and try again.",
        retryAfter || ENTER_WINDOW_SECONDS,
      );
    }

    const entry = await enterChallenge(userId, id);

    // Charged only once the entry landed: a rejected attempt -- closed window,
    // already entered -- should not spend the caller's budget.
    await recordAttempt(enterKey(userId), ENTER_WINDOW_SECONDS);

    res.status(201).json({ entry });
  } catch (error) {
    next(error);
  }
});

export default router;
