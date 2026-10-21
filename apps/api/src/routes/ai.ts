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
import {
  getUserId,
  requireUser,
  requireUserId,
} from "../middleware/current-user.js";
import { runAs } from "../services/ai/caller.js";
import { aiHealth } from "../services/ai/health.js";
import { BIBLE_READ_JOB } from "../services/ai/job-schedule.js";
import { disabledFeatures, setFeature } from "../services/ai/switches.js";
import { assertStoryOwned } from "../services/authoring.js";
import {
  deadJobs,
  enqueue,
  getJob,
  queueCounts,
  retryDeadJob,
} from "../lib/jobs.js";
import { loadAiConfig } from "../services/ai/config.js";
import { assertWithinDailyBudget } from "../services/ai/budget.js";
import { PROMPT_LIMIT, chat, chatStream } from "../services/ai/chat.js";
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
import {
  EXPLAIN_MODES,
  SELECTION_LIMIT as EXPLAIN_SELECTION_LIMIT,
  explain,
  explainStream,
  type ExplainInput,
} from "../services/ai/explain.js";
import {
  generateChapterRecap,
  getChapterRecap,
} from "../services/ai/recap.js";
import { QUERY_LIMIT, SEARCH_MODES, search } from "../services/ai/search.js";
import {
  QUESTION_LIMIT,
  askBook,
  askBookStream,
  type AskBookInput,
} from "../services/ai/ask-book.js";
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  sendMessageStream,
} from "../services/ai/conversations.js";
import {
  addFact,
  getBible,
  refreshBible,
  removeFact,
  updateFact,
} from "../services/ai/story-bible.js";
import {
  checkChapterNow,
  dismissFinding,
  getChapterContinuity,
} from "../services/ai/continuity.js";
import { MESSAGE_LIMIT, runAgent } from "../services/ai/agent.js";
import { getStorySummary, regenerateStorySummaries } from "../services/ai/summaries.js";
import { ensureChapterSummary } from "../services/ai/recap.js";
import { db } from "../prisma/db.js";
import { SPEND_WINDOWS, spendReport, type SpendWindow } from "../services/ai/spend.js";
import { assertAdmin } from "../services/roles.js";
import { FACT_KINDS } from "../services/ai/schemas.js";
import { MAX_PAGE_SIZE } from "../services/stories.js";
import { logger } from "../lib/logger.js";

const router = Router();

/**
 * Every model call a request makes runs as its caller (`services/ai/caller.ts`),
 * which is what the provider's budget check and the usage rows read. Before
 * `requireUser`, which each route still applies: an anonymous request runs as
 * nobody and is then refused by it.
 */
router.use((req, _res, next) => {
  // pino-http's request id, so the request's log line and every provider
  // call and job it causes share one id (`docs/ai-operations.md`).
  runAs(getUserId(req), () => next(), req.id === undefined ? null : String(req.id));
});

/**
 * The floor under every AI route (Task AI 19): no route here is unlimited,
 * including the reads and edits that call no model. Generous -- a reader
 * browsing their conversations or an author tidying a bible never meets it --
 * because its job is to stop a loop, not to ration anybody; each feature's own
 * tighter limit still applies on top. By caller, or by address for an
 * anonymous request, which `requireUser` then refuses anyway.
 */
const BASELINE_WINDOW_SECONDS = 60 * 10;

router.use(async (req, _res, next) => {
  try {
    const limit = loadAiConfig().baselineRequestLimit;
    if (limit <= 0) return next();

    const key = `ai:baseline:${getUserId(req) ?? `ip:${req.ip ?? "unknown"}`}`;
    const status = await isRateLimited(key, limit);
    if (status.limited) {
      throw HttpError.tooManyRequests(
        "That is a lot of requests to the AI features in a short time. Try again in a few minutes.",
        status.retryAfter,
        "ai_requests",
      );
    }
    await recordAttempt(key, BASELINE_WINDOW_SECONDS);
    next();
  } catch (error) {
    next(error);
  }
});

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
 * Server-sent events, once, for every route here that streams.
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

/* Chat ------------------------------------------------------------------- */

/**
 * One model call per request, and the only feature here with no product
 * around it -- which makes it the easiest of the four to point a script at.
 * The window matches the others so the limits read as one policy rather than
 * four opinions.
 */
const CHAT_LIMIT = 30;
const CHAT_WINDOW_SECONDS = 60 * 10;

const chatSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(1, "Type something to send.")
    .max(
      PROMPT_LIMIT,
      // Says the number, because "too long" leaves a caller guessing at a
      // limit that exists to keep the prompt well inside the context window.
      `Keep it under ${PROMPT_LIMIT} characters — this endpoint sends one prompt, not a document.`,
    ),
});

/**
 * Both tolls, before a single token is generated.
 *
 * The request limit is checked first because it is the cheaper read, and
 * neither refusal counts as an attempt: a caller who was turned away did not
 * get to ask, and charging them for it would extend their own lockout.
 */
async function chargeChat(userId: string): Promise<void> {
  const key = `ai:chat:${userId}`;

  const status = await isRateLimited(key, CHAT_LIMIT);
  if (status.limited) {
    throw HttpError.tooManyRequests(
      "You have sent a lot of prompts in a short time. Try again shortly.",
      status.retryAfter,
    );
  }

  await assertWithinDailyBudget(userId);
  await recordAttempt(key, CHAT_WINDOW_SECONDS);
}

/**
 * The smallest end-to-end AI path in the app: validate, charge, call, answer.
 *
 * It returns its token counts to the caller, which no other route here does.
 * `/ai-lab` is a workbench for whatever feature is being built next, and one
 * whose whole job is to show what a request costs cannot keep the number to
 * itself.
 */
router.post("/chat", requireUser, async (req, res, next) => {
  try {
    const userId = requireUserId(res);
    const { prompt } = parseOrThrow(chatSchema, req.body);

    await chargeChat(userId);

    const reply = await chat(prompt, abortOnDisconnect(res).signal);

    res.json(reply);
  } catch (error) {
    next(error);
  }
});

/**
 * The same answer, streamed, because a local model can take half a minute over
 * a paragraph and a blank screen for half a minute reads as a broken app.
 *
 * Three failures this has to handle rather than hope about, all exercised by
 * `ai-chat.test.ts`:
 *
 * - **The client goes away.** `abortOnDisconnect` cancels the provider call,
 *   or we keep generating tokens nobody will read.
 * - **The provider fails mid-stream.** Headers are already out, so a 500 is no
 *   longer available: the failure goes in-band as an `error` frame and the
 *   stream ends.
 * - **A failure before the first byte** is still an ordinary JSON status,
 *   because `writeEvent` does not commit to `200 text/event-stream` until
 *   there is something to write.
 */
router.post("/chat/stream", requireUser, async (req, res, next) => {
  try {
    const userId = requireUserId(res);
    const { prompt } = parseOrThrow(chatSchema, req.body);

    await chargeChat(userId);

    const disconnect = abortOnDisconnect(res);

    for await (const event of chatStream(prompt, disconnect.signal)) {
      if (!writeEvent(res, event)) break;
    }

    res.end();
  } catch (error) {
    if (
      reportStreamFailure(
        res,
        error,
        "The reply stopped unexpectedly.",
        "chat stream failed after headers",
      )
    ) {
      return;
    }

    next(error);
  }
});

/* Scribble --------------------------------------------------------------- */

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
    // Where in the story the passage is, for the story bible. Never used to
    // fetch text; see `assist.ts`.
    chapterId: z.uuid("That chapter could not be found.").nullish(),
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
    chapterId: parsed.chapterId ?? null,
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

/* Reader: recap ---------------------------------------------------------- */

/**
 * Generous, because the read path is free and the write path is idempotent.
 *
 * A reader opening chapter after chapter triggers one `GET` each, and those
 * never reach a model. Only the first reader of a cold chapter pays for a
 * generation, and a second press of the button is answered from the table --
 * so what this limit actually caps is somebody walking a story's chapters to
 * make the machine generate thirty recaps in a row.
 */
const RECAP_LIMIT = 20;
const RECAP_WINDOW_SECONDS = 60 * 10;

/**
 * A story is addressed by slug or id, exactly as `/api/stories/:slugOrId` is,
 * so the reader page can ask with whatever it already has in hand.
 */
const recapParams = z.object({
  slugOrId: z.string().trim().min(1).max(200),
  chapterNumber: z.coerce
    .number()
    .int()
    .min(1, "Chapters are numbered from 1.")
    .max(100000),
});

/**
 * What to show above a chapter, without generating anything.
 *
 * Behind `requireUser` like every other AI route, although it calls no model:
 * the answer it gives is derived from a model's output, it is requested on
 * every chapter open, and an anonymous read path here would be the one place
 * somebody could enumerate which chapters have been summarised. The house rule
 * has no exception for "this one is only a read".
 */
router.get(
  "/recap/:slugOrId/:chapterNumber",
  requireUser,
  async (req, res, next) => {
    try {
      const userId = requireUserId(res);
      const { slugOrId, chapterNumber } = parseOrThrow(recapParams, req.params);

      // No rate limit and no budget check: this is a single indexed lookup
      // that can never reach a provider. Charging for it would make a reader
      // who simply turns pages run out of AI allowance.
      res.json(await getChapterRecap(slugOrId, chapterNumber, userId));
    } catch (error) {
      next(error);
    }
  },
);

/**
 * Writes the recap for the chapter before this one, or returns the stored one.
 *
 * `POST` rather than `GET` because it can spend tens of seconds of CPU and
 * create a row. It is nonetheless idempotent in effect -- the second caller
 * gets the first caller's text -- which is what makes a double-clicked button
 * harmless.
 */
router.post(
  "/recap/:slugOrId/:chapterNumber",
  requireUser,
  async (req, res, next) => {
    try {
      const userId = requireUserId(res);
      const { slugOrId, chapterNumber } = parseOrThrow(recapParams, req.params);

      const key = `ai:recap:${userId}`;
      const status = await isRateLimited(key, RECAP_LIMIT);
      if (status.limited) {
        throw HttpError.tooManyRequests(
          "You have asked for a lot of recaps in a short time. Try again shortly.",
          status.retryAfter,
        );
      }
      await assertWithinDailyBudget(userId);
      await recordAttempt(key, RECAP_WINDOW_SECONDS);

      const result = await generateChapterRecap(
        slugOrId,
        chapterNumber,
        userId,
        abortOnDisconnect(res).signal,
      );


      res.json({ available: result.available, recap: result.recap });
    } catch (error) {
      next(error);
    }
  },
);

/* Reader: explain -------------------------------------------------------- */

/**
 * The widest-open AI surface in the app: every signed-in reader, on every
 * published chapter, rather than only authors on their own drafts. So the
 * limit is tighter than the assistant's and the daily token budget is enforced
 * as well -- a reader stopping to ask about a paragraph does it a few times a
 * chapter, not thirty times a minute.
 */
const EXPLAIN_LIMIT = 20;
const EXPLAIN_WINDOW_SECONDS = 60 * 10;

/**
 * Offsets, never prose.
 *
 * The body cannot carry the passage: the server reads it out of the stored
 * chapter at these offsets, which is what stops this endpoint being a
 * general-purpose model proxy behind the site's key. See the header of
 * `services/ai/explain.ts`. The bounds below are a cheap first pass; the real
 * check is against the chapter's actual length, in the service.
 */
const explainSchema = z
  .object({
    chapterId: z.uuid("That chapter could not be found."),
    start: z.coerce.number().int().min(0),
    end: z.coerce.number().int().min(1),
    mode: z.enum(EXPLAIN_MODES).default("explain"),
  })
  .refine((value) => value.end > value.start, {
    message: "Select some text first.",
    path: ["end"],
  })
  .refine((value) => value.end - value.start <= EXPLAIN_SELECTION_LIMIT, {
    message: `That selection is too long — highlight a sentence or a paragraph at a time (up to ${EXPLAIN_SELECTION_LIMIT} characters).`,
    path: ["end"],
  });

function toExplainInput(
  parsed: z.infer<typeof explainSchema>,
): ExplainInput {
  return {
    chapterId: parsed.chapterId,
    start: parsed.start,
    end: parsed.end,
    mode: parsed.mode,
  };
}

async function chargeExplain(userId: string): Promise<void> {
  const key = `ai:explain:${userId}`;
  const status = await isRateLimited(key, EXPLAIN_LIMIT);
  if (status.limited) {
    throw HttpError.tooManyRequests(
      "You have asked about a lot of passages in a short time. Try again shortly.",
      status.retryAfter,
    );
  }
  await assertWithinDailyBudget(userId);
  await recordAttempt(key, EXPLAIN_WINDOW_SECONDS);
}

router.post("/explain", requireUser, async (req, res, next) => {
  try {
    const userId = requireUserId(res);
    const input = toExplainInput(parseOrThrow(explainSchema, req.body));

    await chargeExplain(userId);

    const result = await explain(
      userId,
      input,
      abortOnDisconnect(res).signal,
    );

    res.json({
      mode: result.mode,
      passage: result.passage,
      text: result.text,
    });
  } catch (error) {
    next(error);
  }
});

/** The same, streamed, because a reader is waiting mid-sentence. */
router.post("/explain/stream", requireUser, async (req, res, next) => {
  try {
    const userId = requireUserId(res);
    const input = toExplainInput(parseOrThrow(explainSchema, req.body));

    await chargeExplain(userId);

    const disconnect = abortOnDisconnect(res);

    for await (const event of explainStream(
      userId,
      input,
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
        "The explanation stopped unexpectedly.",
        "explain stream failed after headers",
      )
    ) {
      return;
    }

    next(error);
  }
});

/* Reader: ask this book -------------------------------------------------- */

/**
 * Explain's numbers, for explain's reason: every signed-in reader can reach
 * this on every published story, and each answer is an embedding plus a
 * generation. A reader asks a handful of questions about a book, not one a
 * second, so the limit is tight and the daily token budget applies.
 */
const ASK_LIMIT = 20;
const NOT_A_CONVERSATION = "That conversation could not be found.";
const ASK_WINDOW_SECONDS = 60 * 10;

/**
 * A story and a question, and optionally how far the reader has read.
 *
 * The question is free text -- unlike explain's offsets, there is no stored
 * thing it could be instead. What stops this being a general model proxy is
 * the service: the model is only ever asked when passages *from this story*
 * cleared the similarity floor, and is told to answer from them alone.
 */
const askBookSchema = z.object({
  storyId: z.string().trim().min(1, "That story could not be found.").max(200),
  question: z
    .string()
    .trim()
    .min(3, "Ask a question about the story.")
    .max(
      QUESTION_LIMIT,
      `Keep it under ${QUESTION_LIMIT} characters — one question at a time.`,
    ),
  upToChapter: z.coerce
    .number()
    .int()
    .min(1, "Chapters are numbered from 1.")
    .max(100000)
    .nullish(),
});

function toAskBookInput(parsed: z.infer<typeof askBookSchema>): AskBookInput {
  return {
    storyKey: parsed.storyId,
    question: parsed.question,
    upToChapter: parsed.upToChapter ?? null,
  };
}

async function chargeAsk(userId: string): Promise<void> {
  const key = `ai:ask:${userId}`;
  const status = await isRateLimited(key, ASK_LIMIT);
  if (status.limited) {
    throw HttpError.tooManyRequests(
      "You have asked a lot of questions in a short time. Try again shortly.",
      status.retryAfter,
    );
  }
  await assertWithinDailyBudget(userId);
  await recordAttempt(key, ASK_WINDOW_SECONDS);
}

router.post("/ask", requireUser, async (req, res, next) => {
  try {
    const userId = requireUserId(res);
    const input = toAskBookInput(parseOrThrow(askBookSchema, req.body));

    await chargeAsk(userId);

    const result = await askBook(userId, input, abortOnDisconnect(res).signal);

    res.json({
      answer: result.answer,
      answerable: result.answerable,
      citations: result.citations,
      scope: result.scope,
    });
  } catch (error) {
    next(error);
  }
});

/** The answer streamed, then its citations on the terminal event. */
router.post("/ask/stream", requireUser, async (req, res, next) => {
  try {
    const userId = requireUserId(res);
    const input = toAskBookInput(parseOrThrow(askBookSchema, req.body));

    await chargeAsk(userId);

    const disconnect = abortOnDisconnect(res);

    for await (const event of askBookStream(userId, input, disconnect.signal)) {
      if (!writeEvent(res, event)) break;
    }

    res.end();
  } catch (error) {
    if (
      reportStreamFailure(
        res,
        error,
        "The answer stopped unexpectedly.",
        "ask stream failed after headers",
      )
    ) {
      return;
    }

    next(error);
  }
});

/* Reader: conversations -------------------------------------------------- */

/**
 * Starting a conversation calls no model, but writes a row; this caps a
 * script filling the table, not a reader, who starts a handful a week.
 */
const CONVERSATION_CREATE_LIMIT = 30;
const CONVERSATION_CREATE_WINDOW_SECONDS = 60 * 10;

const conversationIdSchema = z.object({
  id: z.uuid(NOT_A_CONVERSATION),
});

const startConversationSchema = z.object({
  storyId: z.string().trim().min(1, "That story could not be found.").max(200),
});

const listConversationsSchema = z.object({
  storyId: z.string().trim().min(1, "Which story?").max(200),
});

/** A turn is a question with a bound: Ask This Book's body, minus the story. */
const sendMessageSchema = z.object({
  content: askBookSchema.shape.question,
  upToChapter: askBookSchema.shape.upToChapter,
});

router.post("/conversations", requireUser, async (req, res, next) => {
  try {
    const userId = requireUserId(res);
    const { storyId } = parseOrThrow(startConversationSchema, req.body);

    const key = `ai:conversation:create:${userId}`;
    const status = await isRateLimited(key, CONVERSATION_CREATE_LIMIT);
    if (status.limited) {
      throw HttpError.tooManyRequests(
        "You have started a lot of conversations in a short time. Try again shortly.",
        status.retryAfter,
      );
    }
    await recordAttempt(key, CONVERSATION_CREATE_WINDOW_SECONDS);

    res.status(201).json(await createConversation(userId, storyId));
  } catch (error) {
    next(error);
  }
});

/**
 * The reads and the delete are not rate-limited, for the reason recap's
 * `GET` is not: none of them can reach a model, and every one is scoped to
 * the caller's own rows.
 */
router.get("/conversations", requireUser, async (req, res, next) => {
  try {
    const userId = requireUserId(res);
    const { storyId } = parseOrThrow(listConversationsSchema, req.query);

    res.json(await listConversations(userId, storyId));
  } catch (error) {
    next(error);
  }
});

router.get("/conversations/:id", requireUser, async (req, res, next) => {
  try {
    const userId = requireUserId(res);
    const { id } = parseOrThrow(conversationIdSchema, req.params);

    res.json(await getConversation(userId, id));
  } catch (error) {
    next(error);
  }
});

router.delete("/conversations/:id", requireUser, async (req, res, next) => {
  try {
    const userId = requireUserId(res);
    const { id } = parseOrThrow(conversationIdSchema, req.params);

    await deleteConversation(userId, id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

/**
 * Ask, in a conversation. Streamed only: a turn is the slowest thing a reader
 * can ask for here -- up to three model calls -- and nothing reads it but the
 * panel, which streams.
 *
 * Charged against Ask This Book's limit and budget rather than its own, so a
 * conversation is not a way around them. `tokensUsed` on the terminal event
 * covers the rewrite and the summary as well as the answer.
 */
router.post("/conversations/:id/messages", requireUser, async (req, res, next) => {
  try {
    const userId = requireUserId(res);
    const { id } = parseOrThrow(conversationIdSchema, req.params);
    const body = parseOrThrow(sendMessageSchema, req.body);

    await chargeAsk(userId);

    const disconnect = abortOnDisconnect(res);

    for await (const event of sendMessageStream(
      userId,
      id,
      { content: body.content, upToChapter: body.upToChapter ?? null },
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
        "The answer stopped unexpectedly.",
        "conversation stream failed after headers",
      )
    ) {
      return;
    }

    next(error);
  }
});

/* Search ----------------------------------------------------------------- */

/**
 * The most generous limit here, because a search box is typed into.
 *
 * One request is one embedding of a sentence -- milliseconds on CPU, a
 * fraction of a cent hosted -- and a repeated query is answered from the
 * vector cache without reaching a model at all. What this caps is somebody
 * scripting the endpoint, not a reader refining a query a word at a time,
 * which the page debounces anyway.
 */
const SEARCH_LIMIT = 90;
const SEARCH_WINDOW_SECONDS = 60 * 10;

/**
 * `listStories`' own query parameters, plus `q` and `mode`, so a caller moving
 * from `/api/stories` to here changes a path and a parameter name.
 *
 * `q` may be empty -- that is the fallback to the ordinary list -- so it has a
 * maximum and no minimum.
 */
const searchQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .max(
      QUERY_LIMIT,
      `Keep it under ${QUERY_LIMIT} characters — describe the book in a sentence.`,
    )
    .default(""),
  genreId: z.uuid("Not a known genre.").optional(),
  source: z.enum(["SCRIBE", "CATALOGUE"]).optional(),
  mode: z.enum(SEARCH_MODES).default("hybrid"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(12),
});

/**
 * Hybrid search over stories: their titles and authors, and the meaning of
 * their chapters.
 *
 * No daily token budget, unlike the generation routes: the budget meters
 * tokens a model *writes*, and an embedder writes none. Embedding usage is
 * still logged per call by the provider seam (`feature: "search.query"`).
 */
router.get("/search", requireUser, async (req, res, next) => {
  try {
    const userId = requireUserId(res);
    const query = parseOrThrow(searchQuerySchema, req.query);

    const key = `ai:search:${userId}`;
    const status = await isRateLimited(key, SEARCH_LIMIT);
    if (status.limited) {
      throw HttpError.tooManyRequests(
        "You have searched a lot in a short time. Try again shortly.",
        status.retryAfter,
      );
    }
    await recordAttempt(key, SEARCH_WINDOW_SECONDS);

    res.json(
      await search(
        {
          q: query.q,
          genreId: query.genreId,
          source: query.source,
          mode: query.mode,
          page: query.page,
          limit: query.limit,
        },
        userId,
        abortOnDisconnect(res).signal,
      ),
    );
  } catch (error) {
    next(error);
  }
});

/* Story bible ------------------------------------------------------------- */

/**
 * Generous per call because the work is deliberately cut small: one chapter
 * per request, so reading a forty-chapter story is forty of these in a row.
 * What actually bounds the spend is the daily budget, checked on each one.
 */
const BIBLE_REFRESH_LIMIT = 80;
const BIBLE_REFRESH_WINDOW_SECONDS = 60 * 10;

/** Chapters read by one refresh call. See `refreshBible` for why so few. */
const BIBLE_REFRESH_MAX_CHAPTERS = 3;

const storyIdParams = z.object({
  storyId: z.uuid("That story could not be found."),
});

const factIdParams = z.object({
  factId: z.uuid("That fact could not be found."),
});

const refreshBodySchema = z.object({
  limit: z.coerce.number().int().min(1).max(BIBLE_REFRESH_MAX_CHAPTERS).default(1),
});

/**
 * The same bounds `extractedFactSchema` puts on a model's fact: an author's
 * own fact goes into the same prompts, so it gets the same ceilings.
 */
const factFields = {
  kind: z.enum(FACT_KINDS),
  subject: z.string().trim().min(1, "Who or what is this about?").max(80),
  attribute: z.string().trim().min(1, "What is being said about them?").max(60),
  value: z.string().trim().min(1, "What is the fact?").max(300),
  related: z.string().trim().max(80).nullish(),
};

const addFactSchema = z.object({
  ...factFields,
  chapterId: z.uuid("That chapter could not be found.").nullish(),
});

const updateFactSchema = z
  .object({
    kind: factFields.kind.optional(),
    subject: factFields.subject.optional(),
    attribute: factFields.attribute.optional(),
    value: factFields.value.optional(),
    related: factFields.related,
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "Nothing to change.",
  });

/**
 * The bible as it stands: every live fact with its evidence, and which
 * chapters have been read. Calls no model, so no limit and no budget.
 */
router.get("/bible/:storyId", requireUser, async (req, res, next) => {
  try {
    const { storyId } = parseOrThrow(storyIdParams, req.params);

    res.json(await getBible(requireUserId(res), storyId));
  } catch (error) {
    next(error);
  }
});

/**
 * Reads the next chapter or few that need it. The client calls this until
 * `bible.pending` is zero; each call is short and whatever it read stays read.
 */
router.post("/bible/:storyId/refresh", requireUser, async (req, res, next) => {
  try {
    const userId = requireUserId(res);
    const { storyId } = parseOrThrow(storyIdParams, req.params);
    const { limit } = parseOrThrow(refreshBodySchema, req.body ?? {});

    const key = `ai:bible:${userId}`;
    const status = await isRateLimited(key, BIBLE_REFRESH_LIMIT);
    if (status.limited) {
      throw HttpError.tooManyRequests(
        "You have refreshed the story bible a lot in a short time. Try again shortly.",
        status.retryAfter,
      );
    }
    await assertWithinDailyBudget(userId);
    await recordAttempt(key, BIBLE_REFRESH_WINDOW_SECONDS);

    const result = await refreshBible(
      userId,
      storyId,
      limit,
      abortOnDisconnect(res).signal,
    );

    res.json({ processed: result.processed, bible: result.bible });
  } catch (error) {
    next(error);
  }
});

/**
 * Reads the whole story into its bible in the background (Task AI 20), for an
 * author who would rather not keep the page open while twenty chapters are
 * read. Answers 202 with a job to poll at `GET /jobs/:id`. Charged against the
 * same limit as a refresh, and debounced by story: asking twice while the
 * first is waiting is the same job.
 */
router.post("/bible/:storyId/read", requireUser, async (req, res, next) => {
  try {
    const userId = requireUserId(res);
    const { storyId } = parseOrThrow(storyIdParams, req.params);
    await assertStoryOwned(userId, storyId);

    const key = `ai:bible:${userId}`;
    const status = await isRateLimited(key, BIBLE_REFRESH_LIMIT);
    if (status.limited) {
      throw HttpError.tooManyRequests(
        "You have refreshed the story bible a lot in a short time. Try again shortly.",
        status.retryAfter,
      );
    }
    await assertWithinDailyBudget(userId);
    if (!loadAiConfig().jobs) {
      throw HttpError.unavailable("Background reading is switched off on this server. Use Refresh instead.");
    }
    await recordAttempt(key, BIBLE_REFRESH_WINDOW_SECONDS);

    const jobId = await enqueue(BIBLE_READ_JOB, { storyId }, {
      userId,
      requestId: req.id === undefined ? null : String(req.id),
      dedupeKey: `bible:${storyId}`,
    });
    res.status(202).json({ jobId });
  } catch (error) {
    next(error);
  }
});

/* Story summaries -------------------------------------------------------- */

/**
 * Regenerating is a model call per stale chapter plus a reduce, so it is
 * limited like a bible refresh; reading is the baseline limit only, because a
 * read never calls a model -- a missing summary is queued, not written inline.
 */
const SUMMARY_REGENERATE_LIMIT = 10;
const SUMMARY_REGENERATE_WINDOW_SECONDS = 60 * 10;

const summaryQuerySchema = z.object({
  upToChapter: z.coerce.number().int().min(1, "Chapters are numbered from 1.").max(100000).optional(),
});

const storyKeyParams = z.object({ slugOrId: z.string().trim().min(1).max(200) });

async function chargeSummaryRegenerate(userId: string): Promise<void> {
  const key = `ai:summary:${userId}`;
  const status = await isRateLimited(key, SUMMARY_REGENERATE_LIMIT);
  if (status.limited) {
    throw HttpError.tooManyRequests(
      "You have regenerated a lot of summaries in a short time. Try again shortly.",
      status.retryAfter,
    );
  }
  await assertWithinDailyBudget(userId);
  await recordAttempt(key, SUMMARY_REGENERATE_WINDOW_SECONDS);
}

/**
 * The story so far, as far as this reader has read (or the whole story, for
 * its author). Never calls a model: a missing or stale summary is queued and
 * the reply says `generating`, so the page can ask again in a few seconds.
 */
router.get("/summaries/story/:slugOrId", requireUser, async (req, res, next) => {
  try {
    const { slugOrId } = parseOrThrow(storyKeyParams, req.params);
    const { upToChapter } = parseOrThrow(summaryQuerySchema, req.query);
    res.json(await getStorySummary(requireUserId(res), slugOrId, upToChapter ?? null));
  } catch (error) {
    next(error);
  }
});

/**
 * The author's Regenerate: forgets every stored summary of the story and
 * rewrites the whole-story one in the background, as the author. 202 with a
 * job to poll.
 */
router.post("/summaries/story/:storyId/regenerate", requireUser, async (req, res, next) => {
  try {
    const userId = requireUserId(res);
    const { storyId } = parseOrThrow(storyIdParams, req.params);
    await assertStoryOwned(userId, storyId);
    if (!loadAiConfig().jobs) {
      throw HttpError.unavailable("Background work is switched off on this server, so summaries cannot be regenerated.");
    }
    await chargeSummaryRegenerate(userId);

    const jobId = await regenerateStorySummaries(storyId, userId, req.id === undefined ? null : String(req.id));
    res.status(202).json({ jobId });
  } catch (error) {
    next(error);
  }
});

/**
 * Rewrites one chapter's summary now, for an author who wants different
 * wording. One chapter is one call (a few for a very long one), so it is
 * answered inline. Every story summary that included it goes stale with it.
 */
router.post("/summaries/chapter/:chapterId/regenerate", requireUser, async (req, res, next) => {
  try {
    const userId = requireUserId(res);
    const { chapterId } = parseOrThrow(chapterIdParams, req.params);
    const chapter = await db.orm.content.Chapter.select("id", "storyId", "title", "content", "chapterNumber")
      .where((row) => row.id.eq(chapterId))
      .first();
    if (!chapter) throw HttpError.notFound("That chapter could not be found.");
    await assertStoryOwned(userId, chapter.storyId);
    await chargeSummaryRegenerate(userId);

    const summary = await ensureChapterSummary(chapter, { force: true, signal: abortOnDisconnect(res).signal });
    res.json({ chapterNumber: chapter.chapterNumber, text: summary.text, generatedAt: summary.generatedAt });
  } catch (error) {
    next(error);
  }
});

/* Jobs ------------------------------------------------------------------- */

const jobIdParams = z.object({ id: z.uuid("That job could not be found.") });

/**
 * A background job's status, for the person who caused it and nobody else --
 * another user's job is a 404, as another user's conversation is. What it
 * returns is the status, the attempt count, a stable error code and the
 * handler's small result; never the payload.
 */
router.get("/jobs/:id", requireUser, async (req, res, next) => {
  try {
    const userId = requireUserId(res);
    const { id } = parseOrThrow(jobIdParams, req.params);
    const job = await getJob(id);
    if (!job || job.userId !== userId) throw HttpError.notFound("That job could not be found.");

    res.json({
      id: job.id,
      type: job.type,
      status: job.status,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      error: job.error,
      result: job.result,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/bible/:storyId/facts", requireUser, async (req, res, next) => {
  try {
    const { storyId } = parseOrThrow(storyIdParams, req.params);
    const body = parseOrThrow(addFactSchema, req.body);

    const fact = await addFact(requireUserId(res), storyId, {
      kind: body.kind,
      subject: body.subject,
      attribute: body.attribute,
      value: body.value,
      related: body.related ?? null,
      chapterId: body.chapterId ?? null,
    });

    res.status(201).json({ fact });
  } catch (error) {
    next(error);
  }
});

/** Correcting a fact makes it the author's; see `updateFact`. */
router.patch("/bible/facts/:factId", requireUser, async (req, res, next) => {
  try {
    const { factId } = parseOrThrow(factIdParams, req.params);
    const body = parseOrThrow(updateFactSchema, req.body);

    const fact = await updateFact(requireUserId(res), factId, {
      ...(body.kind !== undefined ? { kind: body.kind } : {}),
      ...(body.subject !== undefined ? { subject: body.subject } : {}),
      ...(body.attribute !== undefined ? { attribute: body.attribute } : {}),
      ...(body.value !== undefined ? { value: body.value } : {}),
      ...(body.related !== undefined ? { related: body.related } : {}),
    });

    res.json({ fact });
  } catch (error) {
    next(error);
  }
});

router.delete("/bible/facts/:factId", requireUser, async (req, res, next) => {
  try {
    const { factId } = parseOrThrow(factIdParams, req.params);

    await removeFact(requireUserId(res), factId);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

/* Continuity -------------------------------------------------------------- */

/** One model call each, sometimes two; an author presses it, not a loop. */
const CONTINUITY_LIMIT = 20;
const CONTINUITY_WINDOW_SECONDS = 60 * 10;

const chapterIdParams = z.object({
  chapterId: z.uuid("That chapter could not be found."),
});

const findingIdParams = z.object({
  findingId: z.uuid("That finding could not be found."),
});

/**
 * What the last check of this chapter found. A read of stored rows: the
 * editor asks on every chapter open, and it never reaches a model.
 */
router.get(
  "/continuity/chapters/:chapterId",
  requireUser,
  async (req, res, next) => {
    try {
      const { chapterId } = parseOrThrow(chapterIdParams, req.params);

      res.json(await getChapterContinuity(requireUserId(res), chapterId));
    } catch (error) {
      next(error);
    }
  },
);

/** The check a quiet minute would have run, now, because the author asked. */
router.post(
  "/continuity/chapters/:chapterId/check",
  requireUser,
  async (req, res, next) => {
    try {
      const userId = requireUserId(res);
      const { chapterId } = parseOrThrow(chapterIdParams, req.params);

      const key = `ai:continuity:${userId}`;
      const status = await isRateLimited(key, CONTINUITY_LIMIT);
      if (status.limited) {
        throw HttpError.tooManyRequests(
          "You have run a lot of continuity checks in a short time. Try again shortly.",
          status.retryAfter,
        );
      }
      await assertWithinDailyBudget(userId);
      await recordAttempt(key, CONTINUITY_WINDOW_SECONDS);

      const result = await checkChapterNow(
        userId,
        chapterId,
        abortOnDisconnect(res).signal,
      );


      res.json(result.continuity);
    } catch (error) {
      next(error);
    }
  },
);

/** "Not a mistake": never raised again for this story. */
router.post(
  "/continuity/findings/:findingId/dismiss",
  requireUser,
  async (req, res, next) => {
    try {
      const { findingId } = parseOrThrow(findingIdParams, req.params);

      await dismissFinding(requireUserId(res), findingId);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  },
);

/* Assistant with tools --------------------------------------------------- */

/**
 * Tighter than Ask This Book's: one request here is up to five model calls and
 * six lookups, so ten requests is fifty calls. The per-request token budget in
 * `agent.ts` bounds one request; this bounds how many of them.
 */
const AGENT_LIMIT = 10;
const AGENT_WINDOW_SECONDS = 60 * 10;

const agentSchema = z.object({
  message: z
    .string()
    .trim()
    .min(2, "Ask the assistant something.")
    .max(
      MESSAGE_LIMIT,
      `Keep it under ${MESSAGE_LIMIT} characters — the assistant looks the rest up.`,
    ),
  /** The story on screen, if any. Authorised by each tool that uses it. */
  storyId: z.string().trim().min(1).max(200).nullish(),
});

/**
 * Ask the assistant, which decides for itself what to look up.
 *
 * Not streamed: what takes the time is the lookups between model calls, and
 * the answer arrives in one piece at the end of them. The trace of what was
 * looked up is returned beside it so nothing about the answer is a black box.
 */
router.post("/agent", requireUser, async (req, res, next) => {
  try {
    const userId = requireUserId(res);
    const body = parseOrThrow(agentSchema, req.body);

    const key = `ai:agent:${userId}`;
    const status = await isRateLimited(key, AGENT_LIMIT);
    if (status.limited) {
      throw HttpError.tooManyRequests(
        "You have asked the assistant a lot in a short time. Try again shortly.",
        status.retryAfter,
      );
    }
    await assertWithinDailyBudget(userId);
    await recordAttempt(key, AGENT_WINDOW_SECONDS);

    const result = await runAgent(
      { message: body.message, storyKey: body.storyId ?? null },
      // The identity every tool runs as. From the session, never the body.
      { userId, signal: abortOnDisconnect(res).signal },
    );


    res.json(result);
  } catch (error) {
    next(error);
  }
});

/* Administration: spend -------------------------------------------------- */

const spendSchema = z.object({
  days: z.coerce
    .number()
    .refine((value): value is SpendWindow => (SPEND_WINDOWS as readonly number[]).includes(value), {
      message: `Choose one of ${SPEND_WINDOWS.join(", ")} days.`,
    })
    .default(7),
});

/**
 * AI spend by feature, model and caller, for administrators. Not rate-limited
 * for the reason the other reads here are not: it calls no model.
 */
router.get("/admin/spend", requireUser, async (req, res, next) => {
  try {
    await assertAdmin(requireUserId(res));
    const { days } = parseOrThrow(spendSchema, req.query);
    res.json(await spendReport(days as SpendWindow));
  } catch (error) {
    next(error);
  }
});

/* Administration: operations --------------------------------------------- */

/**
 * What to look at when AI misbehaves (`docs/ai-operations.md`): provider
 * health, the queue, the dead letters, and which features are switched off.
 */
router.get("/admin/ops", requireUser, async (_req, res, next) => {
  try {
    await assertAdmin(requireUserId(res));
    const [queue, dead, off] = await Promise.all([queueCounts(), deadJobs(20), disabledFeatures()]);
    res.json({
      health: aiHealth(),
      queue,
      dead: dead.map((job) => ({
        id: job.id,
        type: job.type,
        attempts: job.attempts,
        error: job.error,
        updatedAt: job.updatedAt,
      })),
      switchedOff: off,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/admin/jobs/:id/retry", requireUser, async (req, res, next) => {
  try {
    await assertAdmin(requireUserId(res));
    const { id } = parseOrThrow(jobIdParams, req.params);
    if (!(await retryDeadJob(id))) throw HttpError.notFound("No dead job has that id.");
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

const switchSchema = z.object({
  /** A feature id or prefix, as on `AiRequest.feature`: `assist`, `ask.book`. */
  feature: z.string().trim().regex(/^[a-z][a-z0-9_.-]{0,59}$/, "Name a feature, like assist or ask.book."),
  enabled: z.boolean(),
});

/** The kill switch: off within ten seconds, on as fast, no deploy. */
router.put("/admin/switches", requireUser, async (req, res, next) => {
  try {
    await assertAdmin(requireUserId(res));
    const { feature, enabled } = parseOrThrow(switchSchema, req.body);
    res.json({ switchedOff: await setFeature(feature, enabled) });
  } catch (error) {
    next(error);
  }
});

export default router;
