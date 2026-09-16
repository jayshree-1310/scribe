/**
 * Unit tests for the hosted provider. No network and no key: `fetch` is
 * injected, so these assert the request shape, the SSE parsing and the error
 * mapping rather than anything a real service would say.
 */

import { describe, expect, it } from "vitest";
import { HttpError } from "../../lib/http-error.js";
import { loadAiConfig, type AiConfig } from "./config.js";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";
import type { FetchLike } from "./ollama.js";
import type { AiStreamEvent } from "./types.js";

const config = (): AiConfig => ({
  ...loadAiConfig(),
  provider: "openai",
  baseUrl: "https://models.invalid/v1",
  apiKey: "test-key",
  model: "test-model",
});

const request = {
  feature: "test",
  system: "You are a test.",
  messages: [{ role: "user" as const, content: "hello" }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** An SSE body delivered in awkward pieces, the way a network delivers one. */
function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

describe("createOpenAiCompatibleProvider", () => {
  it("sends the system prompt as a message with a role", async () => {
    let sent: unknown;
    const fetchImpl: FetchLike = async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return jsonResponse({
        choices: [{ message: { content: "hi" } }],
        usage: { prompt_tokens: 7, completion_tokens: 2 },
      });
    };

    const result = await createOpenAiCompatibleProvider(
      config(),
      fetchImpl,
    ).complete(request);

    expect(result.text).toBe("hi");
    expect(result.usage.inputTokens).toBe(7);
    expect(result.usage.outputTokens).toBe(2);
    expect(sent).toMatchObject({
      model: "test-model",
      messages: [
        { role: "system", content: "You are a test." },
        { role: "user", content: "hello" },
      ],
    });
  });

  it("sends the key as a bearer token", async () => {
    let auth: string | null = null;
    const fetchImpl: FetchLike = async (_url, init) => {
      auth = new Headers(init?.headers).get("authorization");
      return jsonResponse({ choices: [{ message: { content: "" } }] });
    };

    await createOpenAiCompatibleProvider(config(), fetchImpl).complete(request);

    expect(auth).toBe("Bearer test-key");
  });

  it("reassembles deltas split across reads and ignores the DONE sentinel", async () => {
    const fetchImpl: FetchLike = async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        // A frame arriving in two pieces, which is the normal case.
        'data: {"choices":[{"delta":{"con',
        'tent":"lo"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":1}}\n\n',
        "data: [DONE]\n\n",
      ]);

    const events: AiStreamEvent[] = [];
    for await (const event of createOpenAiCompatibleProvider(
      config(),
      fetchImpl,
    ).stream(request)) {
      events.push(event);
    }

    const text = events
      .filter((event) => event.type === "text")
      .map((event) => (event.type === "text" ? event.text : ""))
      .join("");

    expect(text).toBe("Hello");

    const done = events.at(-1);
    expect(done?.type).toBe("done");
    expect(done?.type === "done" && done.usage.inputTokens).toBe(4);
  });

  it("does not let one malformed frame kill the stream", async () => {
    const fetchImpl: FetchLike = async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
        "data: {not json at all}\n\n",
        'data: {"choices":[{"delta":{"content":"b"}}]}\n\n',
      ]);

    const text: string[] = [];
    for await (const event of createOpenAiCompatibleProvider(
      config(),
      fetchImpl,
    ).stream(request)) {
      if (event.type === "text") text.push(event.text);
    }

    expect(text.join("")).toBe("ab");
  });

  /** A bad key is our misconfiguration, and saying so must not leak whether
   *  a key exists at all. */
  it("maps 401 to a 503 that does not mention the credential", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ error: { message: "Invalid API key sk-abc123" } }, 401);

    await expect(
      createOpenAiCompatibleProvider(config(), fetchImpl).complete(request),
    ).rejects.toMatchObject({ status: 503, code: "service_unavailable" });
  });

  it("maps 429 to a throttle carrying Retry-After", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response("{}", { status: 429, headers: { "retry-after": "12" } });

    const error = await createOpenAiCompatibleProvider(config(), fetchImpl)
      .complete(request)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(429);
    expect((error as HttpError).retryAfterSeconds).toBe(12);
  });

  it("never forwards the provider's own message to the caller", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ error: { message: "prompt was: secret chapter text" } }, 500);

    const error = await createOpenAiCompatibleProvider(config(), fetchImpl)
      .complete(request)
      .catch((cause: unknown) => cause);

    expect((error as HttpError).message).not.toContain("secret chapter text");
    expect((error as HttpError).status).toBe(502);
  });

  it("re-throws a caller's abort untouched rather than as a provider fault", async () => {
    const controller = new AbortController();
    controller.abort();

    const fetchImpl: FetchLike = async () => {
      throw new DOMException("aborted", "AbortError");
    };

    const error = await createOpenAiCompatibleProvider(config(), fetchImpl)
      .complete({ ...request, signal: controller.signal })
      .catch((cause: unknown) => cause);

    expect(error).not.toBeInstanceOf(HttpError);
  });
});
