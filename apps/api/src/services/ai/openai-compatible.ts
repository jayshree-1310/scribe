/**
 * A provider for any server speaking the OpenAI chat-completions API.
 *
 * One implementation covers Groq, OpenRouter, Together, DeepInfra, vLLM and
 * Ollama's own `/v1` endpoint, because they all settled on the same request
 * and response shape. That is the whole reason to target this wire format
 * rather than a specific vendor's SDK: the deployed environment can change
 * supplier with two environment variables and no code change.
 *
 * It exists because **`ollama` cannot be the production provider**. Ollama is
 * a local server, and a free Render instance has neither the memory to hold a
 * model nor a disk to keep one on, so the deployed API had no model server at
 * all and answered every AI request with the "not reachable" 503.
 *
 * Two shapes worth knowing before editing:
 *
 * - Streaming is **SSE**: `data: {json}` frames separated by blank lines, and
 *   a literal `data: [DONE]` sentinel that is not JSON.
 * - Usage arrives only on the final frame, and only when the request asks for
 *   it (`stream_options.include_usage`). Providers that ignore that option
 *   simply report zeros, which is why nothing above this file may assume a
 *   count is present.
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
import type { FetchLike } from "./ollama.js";

interface ChatChoice {
  message?: { content?: string };
  delta?: { content?: string };
}

interface ChatResponse {
  choices?: ChatChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

function toUsage(
  body: ChatResponse,
  model: string,
  startedAt: number,
): AiUsage {
  return {
    provider: "openai",
    model,
    inputTokens: body.usage?.prompt_tokens ?? 0,
    outputTokens: body.usage?.completion_tokens ?? 0,
    durationMs: Date.now() - startedAt,
  };
}

function transportError(cause: unknown, config: AiConfig): HttpError {
  if (cause instanceof DOMException && cause.name === "TimeoutError") {
    return HttpError.upstreamTimeout(
      "The model took too long to respond. Try a shorter request.",
    );
  }

  // No install instructions here, unlike the Ollama provider: a hosted
  // endpoint being unreachable is not something the reader can fix.
  return HttpError.unavailable(
    "The model service is unreachable. Please try again shortly.",
  );
}

/** Maps a non-2xx response. The provider's own message never reaches a client. */
async function responseError(response: Response): Promise<HttpError> {
  const detail = await response.text().catch(() => "");

  if (response.status === 401 || response.status === 403) {
    // A bad or missing key is our configuration problem, not the reader's, and
    // saying which would tell an attacker whether a key exists at all.
    return HttpError.unavailable("AI features are not configured correctly.");
  }

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after") ?? "5");
    return HttpError.tooManyRequests(
      "The model service is busy. Try again shortly.",
      Number.isFinite(retryAfter) ? retryAfter : 5,
    );
  }

  if (response.status === 404) {
    return HttpError.unavailable("The configured model is not available.");
  }

  const error = HttpError.upstream("The model could not complete that request.");
  Object.defineProperty(error, "upstreamDetail", {
    value: { status: response.status, body: detail.slice(0, 500) },
    enumerable: false,
  });
  return error;
}

function signalFor(request: AiRequest, config: AiConfig): AbortSignal {
  const timeout = AbortSignal.timeout(config.timeoutMs);
  return request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
}

function bodyFor(
  request: AiRequest,
  config: AiConfig,
  stream: boolean,
): string {
  return JSON.stringify({
    model: request.model ?? config.model,
    // The system prompt stays a message with a role, exactly as in the local
    // provider: never concatenated onto user text.
    messages: [
      { role: "system", content: request.system },
      ...request.messages,
    ],
    max_tokens: request.maxTokens ?? config.maxTokens,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  });
}

export function createOpenAiCompatibleProvider(
  config: AiConfig,
  fetchImpl: FetchLike = fetch,
): AiProvider {
  const url = `${config.baseUrl}/chat/completions`;

  async function send(request: AiRequest, stream: boolean): Promise<Response> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey ?? ""}`,
        },
        body: bodyFor(request, config, stream),
        signal: signalFor(request, config),
      });
    } catch (cause) {
      if (request.signal?.aborted) throw cause;
      throw transportError(cause, config);
    }

    if (!response.ok) throw await responseError(response);

    return response;
  }

  return {
    name: "openai",

    async complete(request) {
      const startedAt = Date.now();
      const response = await send(request, false);
      const body = (await response.json()) as ChatResponse;

      if (body.error) {
        throw HttpError.upstream("The model could not complete that request.");
      }

      return {
        text: body.choices?.[0]?.message?.content ?? "",
        usage: toUsage(body, request.model ?? config.model, startedAt),
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
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          buffered += decoder.decode(value, { stream: true });

          // SSE frames are separated by a blank line, and a read can end
          // mid-frame, so the tail waits for its delimiter.
          const frames = buffered.split("\n\n");
          buffered = frames.pop() ?? "";

          for (const frame of frames) {
            const line = frame
              .split("\n")
              .find((part) => part.startsWith("data:"));
            if (!line) continue;

            const payload = line.slice(5).trim();
            // The one frame that is deliberately not JSON.
            if (payload === "[DONE]") continue;

            let chunk: ChatResponse;
            try {
              chunk = JSON.parse(payload) as ChatResponse;
            } catch {
              // One malformed frame must not kill a stream that is otherwise
              // delivering text.
              continue;
            }

            const text = chunk.choices?.[0]?.delta?.content;
            if (text) yield { type: "text", text } satisfies AiStreamEvent;

            // Usage rides the final frame, which carries no delta.
            if (chunk.usage) {
              usage = toUsage(chunk, request.model ?? config.model, startedAt);
            }
          }
        }
      } finally {
        reader.cancel().catch(() => undefined);
      }

      yield {
        type: "done",
        usage: usage ?? toUsage({}, request.model ?? config.model, startedAt),
      } satisfies AiStreamEvent;
    },
  };
}
