/**
 * Public profile and follow routes, mounted at `/api/users`.
 *
 * Reading a profile is open -- `/profile/:username` is a public page, and a
 * signed-in caller additionally learns whether they already follow the person
 * -- so this router is not placed behind `requireUser`. The two writes take
 * `requireUser` as route-level middleware instead.
 *
 * Distinct from `routes/account.ts`, which serves the caller *their own*
 * account at `/api/account` and carries fields no stranger may see. Nothing
 * here takes an id from the body: the person being looked at comes from the
 * path, and the person doing the looking from `requireUserId(res)`.
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
  followUser,
  getPublicProfile,
  listFollowers,
  listFollowing,
  listUserStories,
  unfollowUser,
} from "../services/users.js";

const router = Router();

/**
 * Follows one caller may make per window. Keyed by *user* rather than by
 * address, for the reason `routes/clubs.ts` gives: following needs a session,
 * so there is a better subject than the IP, and one office behind a single
 * address should not share one budget.
 *
 * Higher than the comment limit because the honest burst is higher -- working
 * through a followers list and following back is a legitimate hundred clicks
 * in a sitting -- and it still stops a script farming a follower graph.
 */
const FOLLOW_LIMIT = 120;

const FOLLOW_WINDOW_SECONDS = 10 * 60;

function followKey(userId: string): string {
  return `rl:follow:${userId}`;
}

/**
 * Deliberately *not* `usernameSchema` from `lib/auth-schemas.ts`: that one
 * encodes the rules for *creating* an account, and a lookup must not turn a
 * username it would refuse to mint into a 400. An unknown username is a 404
 * whatever its shape. The bound keeps a pathological URL from reaching the
 * database; the service lower-cases it.
 */
const usernameParamSchema = z.object({
  username: z.string().trim().min(1).max(200),
});

const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(24),
});

/* Profile ---------------------------------------------------------------- */

router.get("/:username", async (req, res, next) => {
  try {
    const { username } = parseOrThrow(usernameParamSchema, req.params);

    res.json({ profile: await getPublicProfile(username, getUserId(req)) });
  } catch (error) {
    next(error);
  }
});

router.get("/:username/stories", async (req, res, next) => {
  try {
    const { username } = parseOrThrow(usernameParamSchema, req.params);
    const query = parseOrThrow(pageQuerySchema, req.query);

    res.json(await listUserStories(username, query, getUserId(req)));
  } catch (error) {
    next(error);
  }
});

/* Follow graph ----------------------------------------------------------- */

router.get("/:username/followers", async (req, res, next) => {
  try {
    const { username } = parseOrThrow(usernameParamSchema, req.params);
    const query = parseOrThrow(pageQuerySchema, req.query);

    res.json(await listFollowers(username, query, getUserId(req)));
  } catch (error) {
    next(error);
  }
});

router.get("/:username/following", async (req, res, next) => {
  try {
    const { username } = parseOrThrow(usernameParamSchema, req.params);
    const query = parseOrThrow(pageQuerySchema, req.query);

    res.json(await listFollowing(username, query, getUserId(req)));
  } catch (error) {
    next(error);
  }
});

router.post("/:username/follow", requireUser, async (req, res, next) => {
  try {
    const { username } = parseOrThrow(usernameParamSchema, req.params);
    const userId = requireUserId(res);

    const { limited, retryAfter } = await isRateLimited(
      followKey(userId),
      FOLLOW_LIMIT,
    );
    if (limited) {
      throw HttpError.tooManyRequests(
        "You have followed a lot of people in a short time. Give it a moment and try again.",
        retryAfter || FOLLOW_WINDOW_SECONDS,
      );
    }

    const state = await followUser(userId, username);

    // Charged only once the follow landed: a rejected attempt -- no such
    // person, or yourself -- should not spend the caller's budget.
    await recordAttempt(followKey(userId), FOLLOW_WINDOW_SECONDS);

    // 200 rather than 201: following is idempotent, so the response cannot
    // honestly claim to have created something on the second call.
    res.json(state);
  } catch (error) {
    next(error);
  }
});

router.delete("/:username/follow", requireUser, async (req, res, next) => {
  try {
    const { username } = parseOrThrow(usernameParamSchema, req.params);

    // The refreshed state rather than a 204: the button that just unfollowed
    // has to redraw the follower count either way, and this saves it a
    // follow-up request.
    res.json(await unfollowUser(requireUserId(res), username));
  } catch (error) {
    next(error);
  }
});

export default router;
