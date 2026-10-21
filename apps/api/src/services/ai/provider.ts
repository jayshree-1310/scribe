/**
 * The one place a model client is constructed.
 *
 * Every AI feature calls `aiProvider()`. Nothing else in the codebase
 * constructs a provider, reads `AI_*` configuration, or imports an SDK -- which
 * is what keeps "swap the model" a one-file change and keeps a provider's types
 * out of feature code.
 *
 * The provider returned here is wrapped: once to retry transient failures and
 * record usage, once more to add the structured-output path. All of it belongs
 * here rather than in each implementation, because it is policy and not
 * protocol -- an implementation only ever writes `complete` and `stream`.
 *
 * `aiEmbedder()` is the same idea for embeddings and a **second** accessor
 * rather than a third method, because the two are separately configured and in
 * this repo's own setup are two different services -- see `AiEmbedder` in
 * `types.ts`.
 */

import { HttpError } from "../../lib/http-error.js";
import { logger } from "../../lib/logger.js";
import {
  isAiConfigured,
  isAiEmbedConfigured,
  loadAiConfig,
  loadAiEmbedConfig,
  type AiConfig,
  type AiEmbedConfig,
} from "./config.js";
import { createOllamaEmbedder, createOllamaProvider } from "./ollama.js";
import {
  createOpenAiCompatibleEmbedder,
  createOpenAiCompatibleProvider,
} from "./openai-compatible.js";
import { assertWithinDailyBudget, recordTokenUsage } from "./budget.js";
import { currentUserId } from "./caller.js";
import { withStructured } from "./structured.js";
import type { AiClient, AiEmbedder, AiProvider, AiRequest } from "./types.js";
import { logAiUsage } from "./usage.js";

/* Construction ----------------------------------------------------------- */

function build(config: AiConfig): AiProvider {
  switch (config.provider) {
    case "ollama":
      return createOllamaProvider(config);
    case "openai":
      return createOpenAiCompatibleProvider(config);
    case "anthropic":
      // Deliberately absent. The local provider is the one this project can
      // run for free, and an abstraction over two implementations written
      // before either is exercised is a guess about a shape you have not
      // learned yet. Add it here when there is a key to test it with; nothing
      // above this file changes.
      throw HttpError.unavailable(
        "The hosted AI provider is not implemented yet. Set AI_PROVIDER=ollama.",
      );
  }
}

/* Policy: retries -------------------------------------------------------- */

/**
 * Retryable means "the same request might work in a moment": a provider that
 * is unreachable, busy, or timed out. A 502 is not retried -- the model
 * answered and the answer was unusable, so asking again the same way tends to
 * fail the same way.
 */
function isTransient(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    (error.status === 503 || error.status === 504 || error.status === 429)
  );
}

function backoffMs(attempt: number): number {
  return Math.min(2000, 250 * 2 ** attempt);
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/* Wrapping --------------------------------------------------------------- */

function wrap(inner: AiProvider, config: AiConfig): AiProvider {
  return {
    name: inner.name,

    async complete(request) {
      const startedAt = Date.now();

      for (let attempt = 0; ; attempt += 1) {
        try {
          const result = await inner.complete(request);
          logAiUsage({
            ...result.usage,
            feature: request.feature,
            kind: "chat",
            outcome: "ok",
          });
          return result;
        } catch (error) {
          const retryable =
            isTransient(error) &&
            attempt < config.maxRetries &&
            request.signal?.aborted !== true;

          if (retryable) {
            await wait(backoffMs(attempt));
            continue;
          }

          logAiUsage({
            provider: inner.name,
            model: request.model ?? config.model,
            inputTokens: 0,
            outputTokens: 0,
            durationMs: Date.now() - startedAt,
            feature: request.feature,
            kind: "chat",
            outcome: "error",
            errorCode:
              error instanceof HttpError ? error.code : "internal_error",
          });
          throw error;
        }
      }
    },

    /**
     * No retries on the streaming path.
     *
     * Once a delta has reached the client, a retry would make the reply appear
     * to restart mid-sentence. Retrying only before the first byte would be
     * safe but is not worth the branch: a caller who wants a second attempt
     * can make one, having seen nothing.
     */
    async *stream(request) {
      const startedAt = Date.now();

      try {
        for await (const event of inner.stream(request)) {
          if (event.type === "done") {
            logAiUsage({
              ...event.usage,
              feature: request.feature,
            kind: "chat",
              outcome: "ok",
            });
          }
          yield event;
        }
      } catch (error) {
        logAiUsage({
          provider: inner.name,
          model: request.model ?? config.model,
          inputTokens: 0,
          outputTokens: 0,
          durationMs: Date.now() - startedAt,
          feature: request.feature,
            kind: "chat",
          outcome: "error",
          errorCode: error instanceof HttpError ? error.code : "internal_error",
        });
        throw error;
      }
    },
  };
}

/* Policy: budget and routing ------------------------------------------- */

/**
 * The model for a request: the caller's own choice, else the longest
 * `AI_FEATURE_MODELS` prefix of its feature, else the configured default.
 */
export function modelFor(request: AiRequest, featureModels: Record<string, string>): string | undefined {
  if (request.model) return request.model;
  let best: string | undefined;
  let length = -1;
  for (const [prefix, model] of Object.entries(featureModels)) {
    const matches = request.feature === prefix || request.feature.startsWith(`${prefix}.`);
    if (matches && prefix.length > length) {
      best = model;
      length = prefix.length;
    }
  }
  return best;
}

/**
 * The per-user budget and per-feature routing, around every call (Task AI 18).
 *
 * **Refused before the call.** A caller over today's allowance gets a 429
 * before a token is spent -- every feature, not only the routes that
 * remembered to check, because the check is here rather than in them. Who the
 * caller is comes from `caller.ts`; the platform's own work (moderation,
 * scripts) runs as nobody and is never refused for somebody else's spend.
 *
 * **Charged after it**, with what the provider reported, which is the only
 * number that is not a guess. See `budget.ts` on why that makes it a budget
 * and not a hard stop.
 *
 * Applied to the test fake too (see `setAiProvider`), so a suite can assert
 * that an over-budget call never reached the model.
 */
function withPolicy(inner: AiProvider): AiProvider {
  const routed = (request: AiRequest): AiRequest => {
    const model = modelFor(request, loadAiConfig().featureModels);
    return model && model !== request.model ? { ...request, model } : request;
  };

  /**
   * The one place prompt and completion text may reach a log, and only behind
   * `AI_LOG_CONTENT`, which `config.ts` refuses in production. Debug level,
   * so even a development server set to `info` keeps it out of the stream.
   */
  const logContent = (request: AiRequest, text: string): void => {
    if (!loadAiConfig().logContent) return;
    logger.debug(
      { aiContent: { feature: request.feature, system: request.system, messages: request.messages, reply: text } },
      "AI call content (AI_LOG_CONTENT)",
    );
  };

  return {
    name: inner.name,

    async complete(request) {
      const userId = currentUserId();
      if (userId) await assertWithinDailyBudget(userId);

      const completion = await inner.complete(routed(request));
      logContent(request, completion.text);
      if (userId) {
        await recordTokenUsage(userId, completion.usage.inputTokens + completion.usage.outputTokens);
      }
      return completion;
    },

    async *stream(request) {
      const userId = currentUserId();
      if (userId) await assertWithinDailyBudget(userId);

      let text = "";
      for await (const event of inner.stream(routed(request))) {
        if (event.type === "text") text += event.text;
        // Charged when usage exists, which is the terminal event: a stream
        // the reader abandoned goes uncharged, and was aborted with them.
        if (event.type === "done") {
          logContent(request, text);
          if (userId) {
            await recordTokenUsage(userId, event.usage.inputTokens + event.usage.outputTokens);
          }
        }
        yield event;
      }
    },
  };
}

/**
 * Retry and usage innermost, then budget and routing, structured output on top.
 *
 * The order is the point: the budget is checked once per call that will
 * actually be made, before its retries, and charged with what it cost. `completeStructured` may make two calls, and each
 * one gets its own retries and its own usage record. Wrapped the other way
 * round, a repaired reply would cost two calls and log one, which is exactly
 * the number you would want when asking why the bill moved.
 */
function client(inner: AiProvider, config: AiConfig): AiClient {
  return withStructured(withPolicy(wrap(inner, config)), {
    structuredOutput: config.structuredOutput,
  });
}

/* Access ----------------------------------------------------------------- */

let cached: { config: AiConfig; provider: AiClient } | null = null;

/**
 * The configured provider, or a 503 when AI is not set up.
 *
 * Throwing an `HttpError` rather than returning null means a route that
 * forgets to check still fails correctly, with a message a person can act on,
 * instead of dereferencing undefined.
 */
export function aiProvider(): AiClient {
  if (cached) return cached.provider;

  const config = loadAiConfig();

  if (!isAiConfigured(config)) {
    throw HttpError.unavailable(
      "AI features are not configured on this server.",
    );
  }

  cached = { config, provider: client(build(config), config) };
  return cached.provider;
}

/**
 * Test seam: install a fake, then `resetAiProvider()` in teardown.
 *
 * The fake is given `completeStructured` and the budget-and-routing policy but
 * **not** retries or usage logging:
 * a test that scripts one failure expects one failure, and a test that asserts
 * on `fake.calls` is counting the calls its feature made. The structured path
 * is different -- it is the behaviour under test in `structured.test.ts`, and
 * it is written once rather than duplicated into the fake.
 */
export function setAiProvider(provider: AiProvider | null): void {
  if (provider === null) {
    cached = null;
    return;
  }

  const config = loadAiConfig();
  cached = {
    config,
    provider: withStructured(withPolicy(provider), {
      structuredOutput: config.structuredOutput,
    }),
  };
}

/** Drops the cache so the next call re-reads the environment. */
export function resetAiProvider(): void {
  cached = null;
}

/* Embeddings ------------------------------------------------------------- */

function buildEmbedder(config: AiEmbedConfig): AiEmbedder {
  switch (config.provider) {
    case "ollama":
      return createOllamaEmbedder(config);
    case "openai":
      return createOpenAiCompatibleEmbedder(config);
    case "anthropic":
      // Anthropic publishes no embedding model of its own, so there is nothing
      // to implement here rather than something not yet implemented. A
      // deployment wanting hosted embeddings points `AI_EMBED_*` at a provider
      // that serves them, which speaks the OpenAI wire format above.
      throw HttpError.unavailable(
        "Anthropic serves no embedding model. Set AI_EMBED_PROVIDER=ollama or openai.",
      );
  }
}

/**
 * The same retry and usage policy as `wrap`, over the embedding call.
 *
 * Written out rather than shared with `wrap` because the two wrap different
 * method names over different request shapes, and the version that abstracts
 * over both is longer than both. Retrying is worth more here than on chat: a
 * backfill makes hundreds of calls in a row, so one transient failure
 * otherwise aborts a run that was minutes in.
 */
function wrapEmbedder(inner: AiEmbedder, config: AiEmbedConfig): AiEmbedder {
  return {
    name: inner.name,
    model: inner.model,
    dimensions: inner.dimensions,

    async embed(request) {
      const startedAt = Date.now();

      for (let attempt = 0; ; attempt += 1) {
        try {
          const result = await inner.embed(request);
          logAiUsage({
            ...result.usage,
            feature: request.feature,
            kind: "embed",
            outcome: "ok",
          });
          return result;
        } catch (error) {
          const retryable =
            isTransient(error) &&
            attempt < config.maxRetries &&
            request.signal?.aborted !== true;

          if (retryable) {
            await wait(backoffMs(attempt));
            continue;
          }

          logAiUsage({
            provider: inner.name,
            model: request.model ?? config.model,
            inputTokens: 0,
            outputTokens: 0,
            durationMs: Date.now() - startedAt,
            feature: request.feature,
            kind: "embed",
            outcome: "error",
            errorCode:
              error instanceof HttpError ? error.code : "internal_error",
          });
          throw error;
        }
      }
    },
  };
}

let cachedEmbedder: AiEmbedder | null = null;

/**
 * The configured embedder, or a 503 when embeddings are not set up.
 *
 * A separate accessor from `aiProvider()` on purpose: the two can be, and here
 * usually are, different services. A deployment can have working chat and no
 * embedder, and the failure a caller gets must say which one is missing.
 */
export function aiEmbedder(): AiEmbedder {
  if (cachedEmbedder) return cachedEmbedder;

  const config = loadAiEmbedConfig();

  if (!isAiEmbedConfigured(config)) {
    throw HttpError.unavailable(
      "Embeddings are not configured on this server.",
    );
  }

  cachedEmbedder = wrapEmbedder(buildEmbedder(config), config);
  return cachedEmbedder;
}

/** Test seam, matching `setAiProvider`. The fake gets no retries either. */
export function setAiEmbedder(embedder: AiEmbedder | null): void {
  cachedEmbedder = embedder;
}

/** Drops the cache so the next call re-reads the environment. */
export function resetAiEmbedder(): void {
  cachedEmbedder = null;
}

/**
 * The wrapping policy on its own, for tests that want retries and usage
 * recording around a stub without going through configuration.
 */
export const __wrapForTests = wrap;

export type { AiRequest };
