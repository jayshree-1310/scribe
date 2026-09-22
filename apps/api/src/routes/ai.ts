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
  GENERATION_KINDS,
  MAX_VARIANTS,
  generate,
  refine,
  type GenerationKind,
} from "../services/ai/generate.js";
import {
  ASSIST_ACTIONS,
  CONTEXT_LIMIT,
  SELECTION_LIMIT,
  assist,
  assistStream,
  type AssistInput,
} from "../services/ai/assist.js";
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
 * Server-sent events, once, for the two routes that stream.
 *
 * Headers are written on the *first* event rather than up front, which is what
 * keeps a pre-stream failure an ordinary HTTP status: every service here does
 * its authorisation and its first provider call before yielding anything, so a
 * 403 or a 503 still reaches `errorHandler` as JSON. Committing to
 * `200 text/event-stream` earlier would turn those into fake successes
 * carrying an error frame.
 *
 * Returns false once the socket is gone, so a caller can stop pulling from a
 * generator nobody is reading.
 */
function writeEvent(res: Response, event: unknown): boolean {
  if (!res.headersSent) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // nginx buffers proxied responses by default, which would hold the whole
      // stream until it ended and defeat the point.
      "X-Accel-Buffering": "no",
    });
  }

  if (res.writableEnded) return false;

  res.write(`data: ${JSON.stringify(event)}\n\n`);
  return true;
}

/**
 * Reports a failure that arrived after the status line was already out.
 *
 * `errorHandler` returns early on `headersSent`, and Express's final handler
 * then destroys the socket without a body -- which a reader cannot tell apart
 * from a clean end. So the failure is reported in-band, and the absence of the
 * terminal event is what the client treats as failure.
 *
 * Returns false when the caller should hand the error on to `next` instead.
 */
function reportStreamFailure(
  res: Response,
  error: unknown,
  fallback: string,
  context: string,
): boolean {
  if (res.writableEnded || res.destroyed) return true;
  if (!res.headersSent) return false;

  const reported =
    error instanceof HttpError
      ? { code: error.code, message: error.message }
      : { code: "internal_error", message: fallback };

  logger.error({ err: error }, context);
  res.write(`data: ${JSON.stringify({ type: "error", ...reported })}\n\n`);
  res.end();
  return true;
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
      if (!writeEvent(res, event)) break;
    }

    res.end();
  } catch (error) {
    if (
      reportStreamFailure(
        res,
        error,
        "Scribble stopped unexpectedly.",
        "scribble stream failed after headers",
      )
    ) {
      return;
    }

    next(error);
  }
});

/* Writing assistant ------------------------------------------------------ */

/**
 * Between Scribble's and generation's: one model call per request, but a long
 * one, and an author mid-chapter makes them in bursts.
 */
const ASSIST_LIMIT = 30;
const ASSIST_WINDOW_SECONDS = 60 * 10;

const assistSchema = z
  .object({
    action: z.enum(ASSIST_ACTIONS),
    text: z
      .string()
      .min(1, "Select some text first.")
      .max(
        SELECTION_LIMIT,
        "That selection is too long — work on a few paragraphs at a time.",
      ),
    /**
     * Capped well above the service's own window so the usual case is not
     * truncated twice, and well below anything that would threaten
     * `express.json`'s 256kb: the whole point of the window is that a chapter
     * never travels.
     */
    before: z.string().max(CONTEXT_LIMIT * 4).default(""),
    after: z.string().max(CONTEXT_LIMIT * 4).default(""),
    tone: z.string().trim().min(1).max(60).nullish(),
    storyId: z.uuid("That story could not be found.").nullish(),
  })
  /**
   * The one field that is conditionally required. A `tone` action without a
   * tone would silently become a plain rewrite, which is a worse answer than
   * saying so.
   */
  .refine((value) => value.action !== "tone" || Boolean(value.tone), {
    message: "Which tone are you aiming for?",
    path: ["tone"],
  });

function toAssistInput(parsed: z.infer<typeof assistSchema>): AssistInput {
  return {
    action: parsed.action,
    text: parsed.text,
    before: parsed.before,
    after: parsed.after,
    tone: parsed.tone ?? null,
    storyId: parsed.storyId ?? null,
  };
}

async function chargeAssist(userId: string): Promise<void> {
  const key = `ai:assist:${userId}`;
  const status = await isRateLimited(key, ASSIST_LIMIT);
  if (status.limited) {
    throw HttpError.tooManyRequests(
      "You have asked for a lot of help in a short time. Try again shortly.",
      status.retryAfter,
    );
  }
  await recordAttempt(key, ASSIST_WINDOW_SECONDS);
}

/**
 * The assistant returns text and never writes it anywhere.
 *
 * Applying an edit is the editor's job, after the author has accepted it. That
 * separation is the feature: a failed request, a refused suggestion and a
 * closed tab all leave the draft exactly as it was, without this route having
 * to do anything to achieve it.
 */
router.post("/assist", requireUser, async (req, res, next) => {
  try {
    const userId = requireUserId(res);
    const input = toAssistInput(parseOrThrow(assistSchema, req.body));

    await chargeAssist(userId);

    res.json(await assist(userId, input, abortOnDisconnect(res).signal));
  } catch (error) {
    next(error);
  }
});

/** The same, streamed, because a rewritten scene is a long time to stare at. */
router.post("/assist/stream", requireUser, async (req, res, next) => {
  try {
    const userId = requireUserId(res);
    const input = toAssistInput(parseOrThrow(assistSchema, req.body));

    await chargeAssist(userId);

    const disconnect = abortOnDisconnect(res);

    for await (const event of assistStream(userId, input, disconnect.signal)) {
      if (!writeEvent(res, event)) break;
    }

    res.end();
  } catch (error) {
    if (
      reportStreamFailure(
        res,
        error,
        "The assistant stopped unexpectedly.",
        "assist stream failed after headers",
      )
    ) {
      return;
    }

    next(error);
  }
});

/* Generation ------------------------------------------------------------- */

/**
 * Tighter than Scribble's, because one request here is up to `MAX_VARIANTS`
 * model calls rather than two. The window is the same so the two limits read
 * as one policy.
 */
const GENERATE_LIMIT = 12;
const GENERATE_WINDOW_SECONDS = 60 * 10;

/** Short, because none of these is prose: a brief is a phrase, not an essay. */
const briefField = z.string().trim().min(1).max(400);

const seedSchema = z.object({
  genre: briefField.nullish(),
  theme: briefField.nullish(),
  premise: briefField.nullish(),
  /**
   * One of the caller's own stories. Validated as a uuid here and checked for
   * ownership in the service, which is where the guard already lives -- a
   * second check written here would be a second place to get it wrong.
   */
  storyId: z.uuid("That story could not be found.").nullish(),
});

const generateSchema = z.object({
  seed: seedSchema.default({}),
  /**
   * Capped in the schema *and* in the service. The cost of this endpoint is
   * linear in this number, which makes it the one field a caller has an
   * incentive to inflate.
   */
  count: z.coerce.number().int().min(1).max(MAX_VARIANTS).default(1),
});

const refineSchema = z.object({
  sessionId: z.uuid("That brainstorm could not be found."),
  index: z.coerce.number().int().min(0).max(MAX_VARIANTS - 1),
  instruction: z
    .string()
    .trim()
    .min(1, "What would you like changed?")
    .max(400, "Keep it under 400 characters."),
});

/** Every generation route pays the same toll before it reaches a model. */
async function chargeGeneration(userId: string): Promise<void> {
  const key = `ai:generate:${userId}`;
  const status = await isRateLimited(key, GENERATE_LIMIT);
  if (status.limited) {
    throw HttpError.tooManyRequests(
      "You have generated a lot in a short time. Try again shortly.",
      status.retryAfter,
    );
  }
  await recordAttempt(key, GENERATE_WINDOW_SECONDS);
}

/**
 * One handler for the three kinds.
 *
 * They differ only in which schema the model is constrained to, and that lives
 * in the service. Three copies of this body would be three places to forget
 * the rate limit.
 */
for (const kind of GENERATION_KINDS) {
  router.post(`/generate/${kind}`, requireUser, async (req, res, next) => {
    try {
      const userId = requireUserId(res);
      const { seed, count } = parseOrThrow(generateSchema, req.body);

      await chargeGeneration(userId);

      res.json(
        await generate(
          userId,
          kind satisfies GenerationKind,
          {
            genre: seed.genre ?? null,
            theme: seed.theme ?? null,
            premise: seed.premise ?? null,
            storyId: seed.storyId ?? null,
          },
          count,
          abortOnDisconnect(res).signal,
        ),
      );
    } catch (error) {
      next(error);
    }
  });
}

/**
 * Revises one variant of an earlier generation.
 *
 * The body carries an id and an instruction, never the object being revised:
 * the server already has what the model wrote, and accepting a client's copy
 * of it would let any text be passed off as the model's own output.
 */
router.post("/generate/refine", requireUser, async (req, res, next) => {
  try {
    const userId = requireUserId(res);
    const { sessionId, index, instruction } = parseOrThrow(
      refineSchema,
      req.body,
    );

    await chargeGeneration(userId);

    res.json(
      await refine(
        userId,
        sessionId,
        index,
        instruction,
        abortOnDisconnect(res).signal,
      ),
    );
  } catch (error) {
    next(error);
  }
});

export default router;
