/**
 * The one place a model client is constructed.
 *
 * Every AI feature calls `aiProvider()`. Nothing else in the codebase
 * constructs a provider, reads `AI_*` configuration, or imports an SDK -- which
 * is what keeps "swap the model" a one-file change and keeps a provider's types
 * out of feature code.
 *
 * The provider returned here is wrapped twice: once to retry transient
 * failures, once to record usage. Both belong here rather than in each
 * implementation, because they are policy and not protocol.
 */

import { HttpError } from "../../lib/http-error.js";
import { isAiConfigured, loadAiConfig, type AiConfig } from "./config.js";
import { createOllamaProvider } from "./ollama.js";
import type { AiProvider, AiRequest } from "./types.js";
import { logAiUsage } from "./usage.js";

/* Construction ----------------------------------------------------------- */

function build(config: AiConfig): AiProvider {
  switch (config.provider) {
    case "ollama":
      return createOllamaProvider(config);
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
          outcome: "error",
          errorCode: error instanceof HttpError ? error.code : "internal_error",
        });
        throw error;
      }
    },
  };
}

/* Access ----------------------------------------------------------------- */

let cached: { config: AiConfig; provider: AiProvider } | null = null;

/**
 * The configured provider, or a 503 when AI is not set up.
 *
 * Throwing an `HttpError` rather than returning null means a route that
 * forgets to check still fails correctly, with a message a person can act on,
 * instead of dereferencing undefined.
 */
export function aiProvider(): AiProvider {
  if (cached) return cached.provider;

  const config = loadAiConfig();

  if (!isAiConfigured(config)) {
    throw HttpError.unavailable(
      "AI features are not configured on this server.",
    );
  }

  cached = { config, provider: wrap(build(config), config) };
  return cached.provider;
}

/** Test seam: install a fake, then `resetAiProvider()` in teardown. */
export function setAiProvider(provider: AiProvider | null): void {
  cached =
    provider === null
      ? null
      : { config: loadAiConfig(), provider };
}

/** Drops the cache so the next call re-reads the environment. */
export function resetAiProvider(): void {
  cached = null;
}

/**
 * The wrapping policy on its own, for tests that want retries and usage
 * recording around a stub without going through configuration.
 */
export const __wrapForTests = wrap;

export type { AiRequest };
