/**
 * Unit tests for the AI seam. No database, no network, no provider: these run
 * anywhere, which is the point of the seam.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../lib/http-error.js";
import { isAiConfigured, loadAiConfig } from "./config.js";
import { createOllamaProvider, type FetchLike } from "./ollama.js";
import {
  __wrapForTests,
  aiProvider,
  resetAiProvider,
  setAiProvider,
} from "./provider.js";
import { fakeAiProvider } from "./testing.js";
import { setAiUsageSink } from "./usage.js";
import type { AiUsageRecord } from "./types.js";

const ENV_KEYS = [
  "AI_PROVIDER",
  "AI_BASE_URL",
  "AI_API_KEY",
  "AI_MODEL",
  "AI_FAST_MODEL",
  "AI_MAX_TOKENS",
  "AI_TIMEOUT_MS",
  "AI_MAX_RETRIES",
  "AI_DAILY_TOKEN_BUDGET",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  resetAiProvider();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetAiProvider();
  setAiUsageSink(null);
});

/* Configuration ---------------------------------------------------------- */

describe("AI configuration", () => {
  it("defaults to the free local stack", () => {
    const config = loadAiConfig();

    expect(config.provider).toBe("ollama");
    expect(config.baseUrl).toBe("http://localhost:11434");
    expect(config.apiKey).toBeUndefined();
    expect(isAiConfigured(config)).toBe(true);
  });

  it("treats a hosted provider without a key as unconfigured", () => {
    process.env["AI_PROVIDER"] = "anthropic";

    expect(isAiConfigured(loadAiConfig())).toBe(false);
  });

  it("falls back rather than producing NaN from a bad number", () => {
    process.env["AI_MAX_TOKENS"] = "not-a-number";

    expect(loadAiConfig().maxTokens).toBe(1024);
  });

  it("ignores an unknown provider instead of failing to boot", () => {
    process.env["AI_PROVIDER"] = "sorcery";

    expect(loadAiConfig().provider).toBe("ollama");
  });

  it("points the fast model at the main model unless told otherwise", () => {
    process.env["AI_MODEL"] = "qwen2.5:7b";

    expect(loadAiConfig().fastModel).toBe("qwen2.5:7b");
  });

  it("strips a trailing slash so URLs do not double up", () => {
    process.env["AI_BASE_URL"] = "http://ollama:11434/";

    expect(loadAiConfig().baseUrl).toBe("http://ollama:11434");
  });
});

describe("aiProvider()", () => {
  it("answers 503 when AI is not configured, rather than throwing raw", () => {
    process.env["AI_PROVIDER"] = "anthropic";

    try {
      aiProvider();
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(503);
      expect((error as HttpError).code).toBe("service_unavailable");
    }
  });

  it("reaches no network while unconfigured", () => {
    process.env["AI_PROVIDER"] = "anthropic";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      expect(() => aiProvider()).toThrow();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("returns the injected fake once set", async () => {
    const fake = fakeAiProvider(["hello"]);
    setAiProvider(fake);

    const result = await aiProvider().complete({
      feature: "test",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.text).toBe("hello");
    expect(fake.calls).toHaveLength(1);
  });
});

/* Ollama mapping --------------------------------------------------------- */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function ndjsonResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      // Deliberately split one line across two chunks: a naive reader that
      // does not buffer partial lines passes every other test and fails here.
      const joined = lines.join("\n") + "\n";
      const cut = Math.floor(joined.length / 3);
      controller.enqueue(encoder.encode(joined.slice(0, cut)));
      controller.enqueue(encoder.encode(joined.slice(cut)));
      controller.close();
    },
  });

  return new Response(body, { status: 200 });
}

describe("Ollama provider", () => {
  const config = loadAiConfig;

  it("sends the system prompt as its own message, never concatenated", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      expect(body.messages[0]).toEqual({ role: "system", content: "rules" });
      expect(body.messages[1]).toEqual({ role: "user", content: "question" });
      expect(body.stream).toBe(false);
      return jsonResponse({
        message: { content: "answer" },
        done: true,
        prompt_eval_count: 12,
        eval_count: 5,
      });
    }) as unknown as FetchLike;

    const provider = createOllamaProvider(config(), fetchImpl);
    const result = await provider.complete({
      feature: "chat",
      system: "rules",
      messages: [{ role: "user", content: "question" }],
    });

    expect(result.text).toBe("answer");
    expect(result.usage.inputTokens).toBe(12);
    expect(result.usage.outputTokens).toBe(5);
    expect(result.usage.provider).toBe("ollama");
  });

  it("maps a refused connection to a 503 that names the fix", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as FetchLike;

    const provider = createOllamaProvider(config(), fetchImpl);

    await expect(
      provider.complete({ feature: "chat", system: "s", messages: [] }),
    ).rejects.toMatchObject({
      status: 503,
      code: "service_unavailable",
      message: expect.stringContaining("docker compose"),
    });
  });

  it("maps an unpulled model to a 503 naming the pull command", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "model 'llama3.2:3b' not found" }, 404),
    ) as unknown as FetchLike;

    const provider = createOllamaProvider(config(), fetchImpl);

    await expect(
      provider.complete({ feature: "chat", system: "s", messages: [] }),
    ).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining("ollama pull llama3.2:3b"),
    });
  });

  it("does not leak the provider's message on a server error", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "prompt was: secret unpublished chapter" }, 500),
    ) as unknown as FetchLike;

    const provider = createOllamaProvider(config(), fetchImpl);

    const error: unknown = await provider
      .complete({ feature: "chat", system: "s", messages: [] })
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(HttpError);
    if (!(error instanceof HttpError)) return;

    expect(error.status).toBe(502);
    expect(error.code).toBe("upstream_error");
    // The prompt can be in the provider's message; it must not be in ours,
    // and it must not survive serialisation to the client either.
    expect(error.message).not.toContain("unpublished");
    expect(JSON.stringify(error.toBody())).not.toContain("unpublished");
  });

  it("treats a 200 carrying an error field as a failure", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "something went wrong" }),
    ) as unknown as FetchLike;

    const provider = createOllamaProvider(config(), fetchImpl);

    await expect(
      provider.complete({ feature: "chat", system: "s", messages: [] }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("streams deltas in order across chunk boundaries and ends with usage", async () => {
    const fetchImpl = vi.fn(async () =>
      ndjsonResponse([
        JSON.stringify({ message: { content: "Once " } }),
        JSON.stringify({ message: { content: "upon " } }),
        JSON.stringify({ message: { content: "a time" } }),
        JSON.stringify({
          done: true,
          prompt_eval_count: 7,
          eval_count: 3,
        }),
      ]),
    ) as unknown as FetchLike;

    const provider = createOllamaProvider(config(), fetchImpl);

    const text: string[] = [];
    let usage: AiUsageRecord | undefined;

    for await (const event of provider.stream({
      feature: "chat",
      system: "s",
      messages: [],
    })) {
      if (event.type === "text") text.push(event.text);
      else usage = { ...event.usage, feature: "chat", outcome: "ok" };
    }

    expect(text.join("")).toBe("Once upon a time");
    expect(usage?.inputTokens).toBe(7);
    expect(usage?.outputTokens).toBe(3);
  });

  it("skips a malformed line rather than killing the stream", async () => {
    const fetchImpl = vi.fn(async () =>
      ndjsonResponse([
        JSON.stringify({ message: { content: "good" } }),
        "{ not json",
        JSON.stringify({ done: true, eval_count: 1 }),
      ]),
    ) as unknown as FetchLike;

    const provider = createOllamaProvider(config(), fetchImpl);
    const text: string[] = [];

    for await (const event of provider.stream({
      feature: "chat",
      system: "s",
      messages: [],
    })) {
      if (event.type === "text") text.push(event.text);
    }

    expect(text.join("")).toBe("good");
  });
});

/* Policy: retries and usage --------------------------------------------- */

describe("provider policy", () => {
  it("retries a transient failure and then succeeds", async () => {
    process.env["AI_MAX_RETRIES"] = "2";
    const fake = fakeAiProvider(["recovered"]);
    fake.failNext(HttpError.unavailable("model server down"));

    const wrapped = __wrapForTests(fake, loadAiConfig());
    const result = await wrapped.complete({
      feature: "chat",
      system: "s",
      messages: [],
    });

    expect(result.text).toBe("recovered");
    expect(fake.calls).toHaveLength(2);
  });

  it("does not retry a bad request", async () => {
    process.env["AI_MAX_RETRIES"] = "2";
    const fake = fakeAiProvider();
    fake.failNext(HttpError.upstream("unusable answer"));

    const wrapped = __wrapForTests(fake, loadAiConfig());

    await expect(
      wrapped.complete({ feature: "chat", system: "s", messages: [] }),
    ).rejects.toMatchObject({ status: 502 });
    expect(fake.calls).toHaveLength(1);
  });

  it("records usage on success", async () => {
    const records: AiUsageRecord[] = [];
    setAiUsageSink((record) => records.push(record));

    const wrapped = __wrapForTests(fakeAiProvider(["hi"]), loadAiConfig());
    await wrapped.complete({
      feature: "assist.rewrite",
      system: "s",
      messages: [],
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      feature: "assist.rewrite",
      outcome: "ok",
      provider: "fake",
    });
  });

  it("records usage on failure, with the error code and not the message", async () => {
    const records: AiUsageRecord[] = [];
    setAiUsageSink((record) => records.push(record));

    const fake = fakeAiProvider();
    fake.failNext(HttpError.upstream("model said something private"));
    const wrapped = __wrapForTests(fake, loadAiConfig());

    await expect(
      wrapped.complete({ feature: "chat", system: "s", messages: [] }),
    ).rejects.toThrow();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      outcome: "error",
      errorCode: "upstream_error",
    });
    expect(JSON.stringify(records[0])).not.toContain("private");
  });

  it("records usage once for a stream, from the terminal event", async () => {
    const records: AiUsageRecord[] = [];
    setAiUsageSink((record) => records.push(record));

    const wrapped = __wrapForTests(fakeAiProvider(["streamed"]), loadAiConfig());

    for await (const _event of wrapped.stream({
      feature: "chat",
      system: "s",
      messages: [],
    })) {
      // drain
    }

    expect(records).toHaveLength(1);
    expect(records[0]?.outcome).toBe("ok");
  });

  it("never lets a broken usage sink fail the request", async () => {
    setAiUsageSink(() => {
      throw new Error("sink exploded");
    });

    const wrapped = __wrapForTests(fakeAiProvider(["fine"]), loadAiConfig());

    await expect(
      wrapped.complete({ feature: "chat", system: "s", messages: [] }),
    ).resolves.toMatchObject({ text: "fine" });
  });
});

/* The fake itself -------------------------------------------------------- */

describe("fake provider", () => {
  it("records what it was sent, which is what AI tests assert on", async () => {
    const fake = fakeAiProvider(["reply"]);

    await fake.complete({
      feature: "summary.chapter",
      system: "never invent plot",
      messages: [{ role: "user", content: "chapter text" }],
      model: "llama3.2:3b",
      maxTokens: 256,
    });

    expect(fake.calls[0]).toMatchObject({
      feature: "summary.chapter",
      system: "never invent plot",
      model: "llama3.2:3b",
      maxTokens: 256,
      streamed: false,
    });
    expect(fake.calls[0]?.messages[0]?.content).toBe("chapter text");
  });

  it("stops streaming when the caller aborts", async () => {
    const controller = new AbortController();
    const fake = fakeAiProvider(["a".repeat(64)]);

    const seen: string[] = [];
    for await (const event of fake.stream({
      feature: "chat",
      system: "s",
      messages: [],
      signal: controller.signal,
    })) {
      if (event.type === "text") {
        seen.push(event.text);
        controller.abort();
      }
    }

    // One delta delivered, then the abort observed: no `done`, because the
    // caller went away before generation finished.
    expect(seen).toHaveLength(1);
  });
});
