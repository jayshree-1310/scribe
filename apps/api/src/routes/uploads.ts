/**
 * File uploads.
 *
 * `POST /api/uploads?kind=cover|media` takes the file as the raw request body
 * rather than multipart, the same way `POST /api/account/avatar` does: one
 * file needs no envelope, and this way there is no multipart parser to
 * configure or keep safe. It needs its own body parser with its own limit —
 * `app.ts` caps JSON at 256kb, which no image would fit under.
 *
 * Images are buffered, because they are small and the sniffer wants them
 * whole. Audio and video are *not* — a video at the media cap would be more
 * memory than the process should ever spend on one request — so those requests
 * are deliberately left unparsed and handed to the service as a stream. That
 * is why the body parser below matches `image/*` and nothing else: anything
 * else arrives with `req` still readable.
 *
 * The upload and the row that references it are two steps: this returns a URL,
 * and the caller saves it (`PATCH /api/author/stories/:id` with `coverUrl`).
 * That means an abandoned upload can leak a file, which is the trade for not
 * making every consumer of an upload its own endpoint.
 */

import { Router } from "express";
import express from "express";
import { z } from "zod";
import { HttpError } from "../lib/http-error.js";
import { parseOrThrow } from "../lib/validate.js";
import { isRateLimited, recordAttempt } from "../lib/rate-limit.js";
import { requireUser, requireUserId } from "../middleware/current-user.js";
import {
  MAX_IMAGE_BYTES,
  UPLOAD_KINDS,
  storeImage,
  storeMedia,
} from "../services/uploads.js";

const router = Router();

router.use(requireUser);

/** Uploads per user per window, and how long the window lasts. */
const UPLOAD_LIMIT = 30;
const WINDOW_SECONDS = 15 * 60;

const querySchema = z.object({
  kind: z.enum(UPLOAD_KINDS).default("cover"),
});

/**
 * `type: "image/*"` only chooses *which* requests to buffer. What the bytes
 * actually are is decided by `lib/image.ts`, in the service.
 */
const imageBody = express.raw({ type: "image/*", limit: MAX_IMAGE_BYTES });

router.post("/", imageBody, async (req, res, next) => {
  try {
    const userId = requireUserId(res);
    const { kind } = parseOrThrow(querySchema, req.query);

    const key = `uploads:ratelimit:${userId}`;
    const { limited, retryAfter } = await isRateLimited(key, UPLOAD_LIMIT);

    if (limited) {
      throw HttpError.tooManyRequests(
        "Too many uploads. Please try again later.",
        retryAfter || WINDOW_SECONDS,
      );
    }

    await recordAttempt(key, WINDOW_SECONDS);

    // `express.raw` leaves an empty object behind when the content type did
    // not match. For `media` that is the audio/video case and `req` is still
    // unread; for `cover` it is the "you sent JSON, or nothing" case.
    if (Buffer.isBuffer(req.body)) {
      res.status(201).json(await storeImage(kind, req.body));
      return;
    }

    if (kind !== "media") {
      throw HttpError.badRequest("Send the image as the request body.", {
        file: "Choose a PNG, JPEG, WebP or GIF image.",
      });
    }

    res.status(201).json(await storeMedia(req));
  } catch (error) {
    next(error);
  }
});

export default router;
