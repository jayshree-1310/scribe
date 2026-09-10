/**
 * Ollama provider: a local model server, no API key, no account, no cost.
 *
 * The default implementation, because it is the one anybody can run -- see
 * `docs/AI-BACKLOG.md` § *Running it for free*. It speaks plain HTTP, so there
 * is no SDK here on purpose: the whole surface used is `POST /api/chat`.
 *
 * Two shapes worth knowing before editing this file:
 *
 * - Streaming is **newline-delimited JSON**, not SSE. One object per line,
 *   each with a `message.content` delta, and a final one with `done: true`
 *   carrying the token counts.
 * - Token counts are `prompt_eval_count` / `eval_count`, and they are absent
 *   on early chunks. Normalising them here is what lets everything above this
 *   file speak one `AiUsage` shape.
 */

import { HttpError } from "../../lib/http-error.js";
import type { AiConfig } from "./config.js";
import type {
  AiCompletion,
  AiProvider,
  AiRequest,
  AiStreamEvent,
  AiUsage,
} from "./types.js";

/** Injectable so tests exercise the mapping without a server or a network. */
export type FetchLike = typeof fetch;

interface OllamaChunk {
  message?: { content?: string };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

function toUsage(
  chunk: OllamaChunk,
  model: string,
  startedAt: number,
): AiUsage {
  return {
    provider: "ollama",
    model,
    inputTokens: chunk.prompt_eval_count ?? 0,
    outputTokens: chunk.eval_count ?? 0,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Maps a transport or protocol failure onto an `HttpError`.
 *
 * The local case that matters: the container is not running, which surfaces as
 * a `fetch` TypeError with a `ECONNREFUSED` cause. That is a 503 naming the
 * fix, not a 500 -- "the model server is not reachable" is actionable, "an
 * unexpected error occurred" is not.
 */
function transportError(cause: unknown, config: AiConfig): HttpError {
  if (cause instanceof DOMException && cause.name === "TimeoutError") {
    return HttpError.upstreamTimeout(
      "The model took too long to respond. Try a shorter request.",
    );
  }

  return HttpError.unavailable(
    `The model server at ${config.baseUrl} is not reachable. ` +
      "Start it with `docker compose --profile ai up -d ollama`.",
  );
}

/** Maps a non-2xx response. Never forwards the provider's own message. */
async function responseError(
  response: Response,
  model: string,
): Promise<HttpError> {
  // Read the body for the log, not for the client: it can quote the prompt.
  const detail = await response.text().catch(() => "");

  if (response.status === 404) {
    // Ollama 404s a model it has not pulled, which is configuration rather
    // than a fault, and the fix is one command.
    return HttpError.unavailable(
      `The model "${model}" is not available. ` +
        `Pull it with \`docker compose exec ollama ollama pull ${model}\`.`,
    );
  }

  if (response.status === 429) {
    return HttpError.tooManyRequests(
      "The model server is busy. Try again shortly.",
      5,
    );
  }

  const error = HttpError.upstream("The model could not complete that request.");
  // Attach for the error handler's log; `toBody` never serialises it.
  Object.defineProperty(error, "upstreamDetail", {
    value: { status: response.status, body: detail.slice(0, 500) },
    enumerable: false,
  });
  return error;
}

/**
 * Composes the caller's cancellation with the configured timeout, so a client
 * that disconnects and a model that hangs are both bounded.
 */
function signalFor(request: AiRequest, config: AiConfig): AbortSignal {
  const timeout = AbortSignal.timeout(config.timeoutMs);
  return request.signal
    ? AbortSignal.any([request.signal, timeout])
    : timeout;
}

function bodyFor(
  request: AiRequest,
  config: AiConfig,
  stream: boolean,
): string {
  return JSON.stringify({
    model: request.model ?? config.model,
    // The system prompt is a message with a role, never concatenated onto user
    // text -- that separation is the only thing standing between an
    // instruction and a user who wants to overwrite it.
    messages: [
      { role: "system", content: request.system },
      ...request.messages,
    ],
    stream,
    options: { num_predict: request.maxTokens ?? config.maxTokens },
  });
}

export function createOllamaProvider(
  config: AiConfig,
  fetchImpl: FetchLike = fetch,
): AiProvider {
  const url = `${config.baseUrl}/api/chat`;

  async function send(request: AiRequest, stream: boolean): Promise<Response> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyFor(request, config, stream),
        signal: signalFor(request, config),
      });
    } catch (cause) {
      // A caller-driven abort is not a fault: re-throw it untouched so the
      // route can distinguish "client went away" from "provider broke".
      if (request.signal?.aborted) throw cause;
      throw transportError(cause, config);
    }

    if (!response.ok) {
      throw await responseError(response, request.model ?? config.model);
    }

    return response;
  }

  return {
    name: "ollama",

    async complete(request) {
      const startedAt = Date.now();
      const response = await send(request, false);
      const chunk = (await response.json()) as OllamaChunk;

      // A 200 carrying an `error` field: Ollama does this for some model-level
      // failures, so a status check alone is not enough.
      if (chunk.error) {
        throw HttpError.upstream("The model could not complete that request.");
      }

      return {
        text: chunk.message?.content ?? "",
        usage: toUsage(chunk, request.model ?? config.model, startedAt),
      } satisfies AiCompletion;
    },

    async *stream(request) {
      const startedAt = Date.now();
      const response = await send(request, true);

      if (!response.body) {
        throw HttpError.upstream("The model returned an empty stream.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      let usage: AiUsage | undefined;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffered += decoder.decode(value, { stream: true });

          // NDJSON: split on newlines and keep the trailing partial line. A
          // chunk boundary lands mid-object often enough that not buffering
          // here fails only under load, which is the worst way to find out.
          const lines = buffered.split("\n");
          buffered = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed === "") continue;

            let chunk: OllamaChunk;
            try {
              chunk = JSON.parse(trimmed) as OllamaChunk;
            } catch {
              // One malformed line must not kill a stream that is otherwise
              // delivering text.
              continue;
            }

            if (chunk.error) {
              throw HttpError.upstream("The model stopped unexpectedly.");
            }

            const text = chunk.message?.content;
            if (text) yield { type: "text", text } satisfies AiStreamEvent;

            if (chunk.done) {
              usage = toUsage(chunk, request.model ?? config.model, startedAt);
            }
          }
        }
      } finally {
        // Releasing the lock cancels the body, which tells the server to stop
        // generating for a caller that abandoned the iterator.
        reader.cancel().catch(() => undefined);
      }

      yield {
        type: "done",
        usage:
          usage ?? toUsage({}, request.model ?? config.model, startedAt),
      } satisfies AiStreamEvent;
    },
  };
}
