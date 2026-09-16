/**
 * AI routes, mounted at `/api/ai`.
 *
 * Everything here is behind `requireUser` and rate-limited without exception:
 * generation costs CPU on this machine and money on a hosted provider, and an
 * unauthenticated AI endpoint is an open wallet either way.
 *
 * The router stays thin, as every router here does -- validate, call a
 * service, answer. The model work lives in `services/ai/`.
 */

import { Router, type Response } from "express";
import { z } from "zod";
import { HttpError } from "../lib/http-error.js";
import { isRateLimited, recordAttempt } from "../lib/rate-limit.js";
import { parseOrThrow } from "../lib/validate.js";
import { requireUser, requireUserId } from "../middleware/current-user.js";
import {
  ask,
  askStream,
  type ScribbleContext,
} from "../services/ai/scribble.js";
import { logger } from "../lib/logger.js";

const router = Router();

/**
 * Deliberately tighter than the auth limiter's: a model call occupies a CPU
 * core for seconds, so a handful of concurrent users is enough to make the
 * whole API feel broken. Reuses `lib/rate-limit.ts` rather than adding a
 * second limiter.
 */
const SCRIBBLE_LIMIT = 20;
const SCRIBBLE_WINDOW_SECONDS = 60 * 10;

/**
 * A signal that fires when the client actually goes away, so a model call it
 * will never read is not left running.
 *
 * Watches the *response*, not the request. `req`'s "close" fires as soon as
 * the request stream finishes -- and `express.json()` has already read the
 * body to the end by the time a handler runs, so Node's auto-destroy closes
 * it immediately. Wiring an abort to that cancels generation on every single
 * call, and reading `req.destroyed` in a catch reports "client gone" for a
 * client that is still waiting. `res` closes only when the connection really
 * ends, and `writableEnded` separates a normal finish from a disconnect.
 */
function abortOnDisconnect(res: Response): AbortController {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller;
}

/**
 * The previous turn's filters, so a follow-up can narrow them.
 *
 * Optional, and validated like any other input. It is the client's own copy of
 * what the last reply reported, which is why forging it grants nothing: the
 * genre is re-resolved against the real genre list, and retrieval applies the
 * same visibility rules either way.
 */
const contextSchema = z.object({
  genre: z.string().trim().min(1).max(60).nullish(),
  kidsAppropriate: z.boolean().nullish(),
  completed: z.boolean().nullish(),
  search: z.string().trim().min(1).max(120).nullish(),
});

const askSchema = z.object({
  message: z
    .string()
    .trim()
    .min(1, "Ask me something.")
    .max(500, "Keep it under 500 characters — a sentence is plenty."),
  context: contextSchema.nullish(),
});

/** Normalises the optional block into the shape the service expects. */
function toContext(
  input: z.infer<typeof askSchema>["context"],
): ScribbleContext | undefined {
  if (!input) return undefined;

  return {
    genre: input.genre ?? null,
    kidsAppropriate: input.kidsAppropriate ?? false,
    completed: input.completed ?? null,
    search: input.search ?? null,
  };
}

router.post("/scribble", requireUser, async (req, res, next) => {
  try {
    const userId = requireUserId(res);
    const { message, context } = parseOrThrow(askSchema, req.body);

    const key = `ai:scribble:${userId}`;
    const status = await isRateLimited(key, SCRIBBLE_LIMIT);
    if (status.limited) {
      throw HttpError.tooManyRequests(
        "You have asked Scribble a lot in a short time. Try again shortly.",
        status.retryAfter,
      );
    }
    await recordAttempt(key, SCRIBBLE_WINDOW_SECONDS);

    res.json(
      await ask(
        message,
        userId,
        toContext(context),
        abortOnDisconnect(res).signal,
      ),
    );
  } catch (error) {
    next(error);
  }
});

/**
 * The same answer, streamed.
 *
 * Why a second route rather than a flag on the first: the non-streaming path
 * retries transient provider failures and the streaming one deliberately does
 * not (`provider.ts`), so they are genuinely different contracts. The JSON
 * route stays the simple one, and is what the tests and any non-browser
 * caller use.
 *
 * SSE over POST, so it cannot be an `EventSource` -- the client reads the body
 * with a reader. That is the price of sending a request body, and the web
 * client already has to do its own read path because `request()` always ends
 * in `response.json()`.
 */
router.post("/scribble/stream", requireUser, async (req, res, next) => {
  try {
    const userId = requireUserId(res);
    const { message, context } = parseOrThrow(askSchema, req.body);

    const key = `ai:scribble:${userId}`;
    const status = await isRateLimited(key, SCRIBBLE_LIMIT);
    if (status.limited) {
      throw HttpError.tooManyRequests(
        "You have asked Scribble a lot in a short time. Try again shortly.",
        status.retryAfter,
      );
    }
    await recordAttempt(key, SCRIBBLE_WINDOW_SECONDS);

    const disconnect = abortOnDisconnect(res);

    /**
     * Headers are deliberately NOT flushed here.
     *
     * `askStream` yields nothing until both the intent call and retrieval have
     * succeeded, and every provider-availability failure -- not configured,
     * unreachable, model not pulled -- is raised by that first call. Writing a
     * `200 text/event-stream` before it would turn a real 503 into a fake
     * success carrying an error frame, contradicting the status table in
     * `docs/ai-architecture.md` and the web client's status-to-message map.
     *
     * So the first `write` below is what commits to streaming, and everything
     * before it still reaches `errorHandler` as an ordinary JSON error.
     */
    for await (const event of askStream(
      message,
      userId,
      toContext(context),
      disconnect.signal,
    )) {
      if (!res.headersSent) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          // nginx buffers proxied responses by default, which would hold the
          // whole stream until it ended and defeat the point.
          "X-Accel-Buffering": "no",
        });
      }

      if (res.writableEnded) break;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    res.end();
  } catch (error) {
    // The client going away is not a fault, and there is no socket left to
    // report it on.
    if (res.writableEnded || res.destroyed) return;

    /**
     * Once the status line is out, `errorHandler` bails (it returns early on
     * `headersSent`) and Express's final handler destroys the socket without
     * a body -- which a reader cannot tell apart from a clean end. So a
     * mid-stream failure is reported in-band, and the absence of `done` is
     * what the client treats as failure.
     */
    if (res.headersSent) {
      const reported =
        error instanceof HttpError
          ? { code: error.code, message: error.message }
          : { code: "internal_error", message: "Scribble stopped unexpectedly." };

      logger.error({ err: error }, "scribble stream failed after headers");
      res.write(`data: ${JSON.stringify({ type: "error", ...reported })}\n\n`);
      res.end();
      return;
    }

    next(error);
  }
});

export default router;
