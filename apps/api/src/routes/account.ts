/**
 * The signed-in reader's own account: profile fields and avatar.
 *
 * Every route needs a user, so the whole router sits behind `requireUser` and
 * each handler reads the id back from `res.locals` rather than trusting
 * anything in the request.
 */

import { Router } from "express";
import express from "express";
import { z } from "zod";
import { HttpError } from "../lib/http-error.js";
import { parseOrThrow } from "../lib/validate.js";
import { isRateLimited, recordAttempt } from "../lib/rate-limit.js";
import { emailSchema, usernameSchema } from "../lib/auth-schemas.js";
import { clearRefreshCookie } from "../lib/sessions.js";
import { requireUser, requireUserId } from "../middleware/current-user.js";
import {
  MAX_AVATAR_BYTES,
  deleteAccount,
  getProfile,
  removeAvatar,
  setAvatar,
  updateProfile,
} from "../services/account.js";

const router = Router();

router.use(requireUser);

/** Matches the counter the settings form shows. */
const BIO_MAX = 280;

const updateSchema = z
  .object({
    username: usernameSchema.optional(),
    email: emailSchema.optional(),
    displayName: z.string().trim().max(60, "Use at most 60 characters.").optional(),
    bio: z.string().trim().max(BIO_MAX, `Use at most ${BIO_MAX} characters.`).optional(),
  })
  // An empty body is a no-op the caller almost certainly did not mean, and
  // answering 200 to it hides a broken form.
  .refine((value) => Object.keys(value).length > 0, {
    message: "Nothing to update.",
  });

/**
 * Deleting an account asks for the username back, and for the password when
 * the account has one — see `services/account.ts` for why each is there.
 */
const deleteSchema = z.object({
  confirmUsername: z.string().trim().min(1, "Type your username to confirm."),
  password: z.string().min(1).max(128).optional(),
});

/** Avatar uploads per user per window, and how long the window lasts. */
const AVATAR_UPLOAD_LIMIT = 10;
const AVATAR_WINDOW_SECONDS = 15 * 60;

/**
 * The avatar arrives as the raw request body rather than multipart: one field
 * needs no envelope, and this way there is no multipart parser to configure or
 * keep safe. It gets its own body parser with its own limit — `app.ts` caps
 * JSON at 256kb, which no image would fit under.
 *
 * `type: "image/*"` only chooses *which* requests to buffer. What the bytes
 * actually are is decided by `lib/image.ts`, in the service.
 */
const avatarBody = express.raw({
  type: "image/*",
  limit: MAX_AVATAR_BYTES,
});

router.get("/me", async (_req, res, next) => {
  try {
    res.json(await getProfile(requireUserId(res)));
  } catch (error) {
    next(error);
  }
});

router.patch("/me", async (req, res, next) => {
  try {
    const body = parseOrThrow(updateSchema, req.body);

    res.json(await updateProfile(requireUserId(res), body));
  } catch (error) {
    next(error);
  }
});

router.post("/avatar", avatarBody, async (req, res, next) => {
  try {
    const userId = requireUserId(res);
    const key = `account:ratelimit:avatar:${userId}`;

    const { limited, retryAfter } = await isRateLimited(key, AVATAR_UPLOAD_LIMIT);

    if (limited) {
      throw HttpError.tooManyRequests(
        "Too many avatar uploads. Please try again later.",
        retryAfter || AVATAR_WINDOW_SECONDS,
      );
    }

    await recordAttempt(key, AVATAR_WINDOW_SECONDS);

    // `express.raw` leaves an empty object behind when the content type did
    // not match, which is the "you sent JSON, or nothing" case.
    if (!Buffer.isBuffer(req.body)) {
      throw HttpError.badRequest("Send the image as the request body.", {
        avatar: "Choose a PNG, JPEG, WebP or GIF image.",
      });
    }

    res.json(await setAvatar(userId, req.body));
  } catch (error) {
    next(error);
  }
});

/**
 * Closing the account. A body on a DELETE is unusual, but the confirmation it
 * carries has to be on the request that performs the deletion — putting it in
 * the query string would write it into every access log on the way.
 *
 * The refresh cookie is scoped to `/api/auth` so it cannot be *read* here,
 * but `Set-Cookie` names the path it clears, so it can still be removed.
 */
router.delete("/me", async (req, res, next) => {
  try {
    const body = parseOrThrow(deleteSchema, req.body ?? {});

    await deleteAccount(requireUserId(res), body);

    clearRefreshCookie(res);

    res.json({ message: "Your account has been deleted." });
  } catch (error) {
    next(error);
  }
});

router.delete("/avatar", async (_req, res, next) => {
  try {
    res.json(await removeAvatar(requireUserId(res)));
  } catch (error) {
    next(error);
  }
});

export default router;
