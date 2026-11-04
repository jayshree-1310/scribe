/**
 * The CopilotKit trial (Task AI 25): Scribe's agent behind CopilotKit's own
 * runtime, end to end, with the fake provider.
 *
 * These are the trial's recorded checks, as far as a server test reaches:
 * that the caller set by `runAs` survives the runtime's async code into the
 * agent, so usage and the budget land on the right user; that a 401, a 429
 * and a provider outage reach the caller; that a thread is its owner's; and
 * that what the runtime serves beyond a run is not reachable.
 */

/** See `ai.test.ts`: `lib/redis.ts` reads `REDIS_URL` at module scope. */
import "dotenv/config";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../lib/http-error.js";
import { connectRedis, redis } from "../lib/redis.js";
import { dailyBudgetKey } from "../services/ai/budget.js";
import { loadAiConfig } from "../services/ai/config.js";
import { __wrapForTests, resetAiProvider, setAiProvider } from "../services/ai/provider.js";
import { addFact } from "../services/ai/story-bible.js";
import { fakeAiProvider, type FakeAiProvider, type FakeReply } from "../services/ai/testing.js";
import { setAiUsageSink } from "../services/ai/usage.js";
import type { AiUsageRecord } from "../services/ai/types.js";
import { TestApi, databaseAvailable } from "../test/harness.js";

const api = new TestApi();
const available = await databaseAvailable();

const BASE = "/api/ai/copilotkit";
const SECRET_FACT = "violet, flecked with gold";
const ENV = ["AI_COPILOTKIT", "AI_DAILY_TOKEN_BUDGET"] as const;
const saved: Partial<Record<(typeof ENV)[number], string | undefined>> = {};

let authorId: string;
let readerId: string;
let story: { id: string; slug: string };
let provider: FakeAiProvider;
let usage: AiUsageRecord[];

beforeAll(async () => {
  if (!available) return;
  for (const name of ENV) saved[name] = process.env[name];
  await api.start();
  authorId = await api.createUser("ka");
  readerId = await api.createUser("kr");
  story = await api.createStory({ title: "The Lamp Room", authorId });
  await api.createChapter({
    storyId: story.id,
    number: 1,
    title: "Quay",
    content: "Mira's eyes were green as bottle glass. The tide came in.",
    published: true,
  });
  await addFact(authorId, story.id, {
    kind: "character",
    subject: "Mira",
    attribute: "eye colour",
    value: SECRET_FACT,
    related: null,
    chapterId: null,
  });
});

afterAll(async () => {
  if (!available) return;
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  setAiUsageSink(null);
  resetAiProvider();
  await api.stop();
});

beforeEach(async () => {
  if (!available) return;
  process.env["AI_COPILOTKIT"] = "on";
  delete process.env["AI_DAILY_TOKEN_BUDGET"];
  usage = [];
  setAiUsageSink((record) => usage.push(record));
  await connectRedis();
  for (const id of [authorId, readerId]) {
    for (const key of await redis.keys(`ai:*:${id}`)) await redis.del(key);
    await redis.del(dailyBudgetKey(id));
  }
});

afterEach(() => {
  setAiUsageSink(null);
  resetAiProvider();
});

/** Wrapped in the seam's usage policy too, so the test sees each call's usage record. */
function script(...replies: FakeReply[]): FakeAiProvider {
  provider = fakeAiProvider([...replies, "Done."]);
  setAiProvider(__wrapForTests(provider, loadAiConfig()));
  return provider;
}

function call(name: string, args: unknown): FakeReply {
  return { toolCalls: [{ name, arguments: JSON.stringify(args) }] };
}

let runs = 0;
/** A run's body as the hooks send it: a fresh run id, the thread, the messages. */
function runInput(message: string, fields: Record<string, unknown> = {}) {
  runs += 1;
  return {
    threadId: `thread-${Date.now()}-${runs}`,
    runId: `run-${runs}`,
    messages: [{ id: `m-${runs}`, role: "user", content: message }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
    ...fields,
  };
}

/** A runtime route, read to the end: JSON when it is not a stream. */
async function send(
  path: string,
  as: string | undefined,
  body?: unknown,
  method = "POST",
): Promise<{ status: number; streamed: boolean; events: Record<string, any>[]; body: any }> {
  const response = await fetch(`${api.baseUrl}${BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(as ? { "x-scribe-user-id": as } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return {
      status: response.status,
      streamed: false,
      events: [],
      body: await response.json().catch(() => null),
    };
  }

  const events = (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, any>);
  return { status: response.status, streamed: true, events, body: null };
}

const types = (events: Record<string, any>[]) => events.map((event) => event["type"]);

describe.skipIf(!available)("the CopilotKit trial", () => {
  describe("reachability", () => {
    it("is a 404 while the trial is off, and needs a session when it is on", async () => {
      script("unused");
      process.env["AI_COPILOTKIT"] = "off";
      expect((await send("/info", authorId, undefined, "GET")).status).toBe(404);

      process.env["AI_COPILOTKIT"] = "on";
      expect((await send("/info", undefined, undefined, "GET")).status).toBe(401);
      const info = await send("/info", authorId, undefined, "GET");
      expect(info.status).toBe(200);
      expect(Object.keys(info.body.agents)).toEqual(["scribe"]);
      expect(info.body.telemetryDisabled).toBe(true);
    });

    it("serves only info, run, connect and stop for the one agent", async () => {
      script("unused");
      const refused = await Promise.all([
        send("/agent/scribe/suggest", authorId, runInput("Hello there.")),
        send("/agent/default/run", authorId, runInput("Hello there.")),
        send("/threads", authorId, undefined, "GET"),
        send("/threads/clear", authorId, {}),
        send("/transcribe", authorId, {}),
        send("/cpk-debug-events", authorId, undefined, "GET"),
        send("/inspector-metadata", authorId, undefined, "GET"),
        send("/memories", authorId, undefined, "GET"),
        send("/info", authorId, {}),
      ]);

      expect(refused.map((response) => response.status)).toEqual(refused.map(() => 404));
      expect(provider.calls).toHaveLength(0);
    });
  });

  describe("a run", () => {
    it("streams the agent's AG-UI events, as the session's user all the way into the tools", async () => {
      script(call("get_character_facts", { storyId: story.id, subject: "Mira" }), "Her eyes are violet.");

      const author = await send("/agent/scribe/run", authorId, runInput("What colour are Mira's eyes?"));

      expect(author.status).toBe(200);
      expect(types(author.events)).toEqual([
        "RUN_STARTED",
        "TOOL_CALL_START",
        "TOOL_CALL_ARGS",
        "TOOL_CALL_END",
        "TOOL_CALL_RESULT",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "RUN_FINISHED",
      ]);
      expect(JSON.parse(author.events[4]?.["content"])).toMatchObject({ outcome: "ok" });

      // The caller survived the runtime's async code: every provider call,
      // and so every usage row and the day's budget, is the author's.
      expect(usage.length).toBeGreaterThan(0);
      expect(usage.map((record) => record.userId)).toEqual(usage.map(() => authorId));
      expect(Number(await redis.get(dailyBudgetKey(authorId)))).toBeGreaterThan(0);

      // And the same tool, asked by a reader, is the reader's -- refused.
      usage = [];
      script(call("get_character_facts", { storyId: story.id, subject: "Mira" }), "I can't see that.");
      const reader = await send(
        "/agent/scribe/run",
        readerId,
        runInput("What colour are Mira's eyes?", {
          forwardedProps: { userId: authorId, storyId: story.slug },
          state: { userId: authorId },
        }),
      );
      expect(JSON.parse(reader.events[4]?.["content"])).toMatchObject({ outcome: "refused" });
      expect(JSON.stringify(provider.calls[1]?.messages)).not.toContain(SECRET_FACT);
      expect(usage.map((record) => record.userId)).toEqual(usage.map(() => readerId));
    });

    it("never offers the model a tool the browser declared", async () => {
      script("Hello.");
      const declared = [
        { name: "propose_edit", description: "Rendered by the client.", parameters: {} },
        { name: "search_chapters", description: "Shadowed by the client.", parameters: {} },
        { name: "delete_story", description: "Added by the client.", parameters: {} },
      ];

      const response = await send("/agent/scribe/run", readerId, runInput("Hello there.", { tools: declared }));

      expect(response.status).toBe(200);
      const offered = provider.calls[0]?.tools ?? [];
      expect(offered.map((tool) => tool.name)).not.toContain("delete_story");
      expect(offered.map((tool) => tool.name)).not.toContain("propose_edit");
      expect(offered.find((tool) => tool.name === "search_chapters")?.description).not.toBe(
        "Shadowed by the client.",
      );
    });

    it("keeps a thread to its owner", async () => {
      script("The tide came in.");
      const input = runInput("What happens at the quay?");
      await send("/agent/scribe/run", authorId, input);

      const connect = { ...input, runId: "run-connect", messages: [] };
      const stranger = await send("/agent/scribe/connect", readerId, connect);
      const owner = await send("/agent/scribe/connect", authorId, connect);

      // Not refused with a status: the runtime answers a thread that is not
      // yours as one with nothing in it, which says no more than a refusal.
      expect(stranger.events).toEqual([]);
      expect(JSON.stringify(stranger.body)).not.toContain("tide");
      expect(JSON.stringify(owner.events)).toContain("The tide came in.");

      // Nor can a stranger run on it, which would add to the owner's thread.
      const calls = provider.calls.length;
      const hijack = await send("/agent/scribe/run", readerId, { ...input, runId: "run-hijack" });
      expect(hijack.status).toBe(404);
      expect(provider.calls).toHaveLength(calls);
    });
  });

  describe("failures", () => {
    it("answers a bad body, the request limit and the day's budget with a status, before any model call", async () => {
      script("unused");
      const empty = await send("/agent/scribe/run", readerId, runInput(" "));

      process.env["AI_DAILY_TOKEN_BUDGET"] = "10";
      await redis.set(dailyBudgetKey(readerId), "50", { EX: 600 });
      const spent = await send("/agent/scribe/run", readerId, runInput("Hello there."));

      expect(empty).toMatchObject({ status: 400, streamed: false });
      expect(spent).toMatchObject({ status: 429, streamed: false });
      expect(spent.body.error.details?.limit).toBe("daily_token_budget");
      expect(spent.body.error.retryAfterSeconds).toBeGreaterThan(0);
      expect(provider.calls).toHaveLength(0);
    });

    it("reports a provider outage in-band, with its code, because the runtime has already said 200", async () => {
      script("unused");
      // Unwrapped: the seam's policy would retry a 503 once, and the retry succeed.
      setAiProvider(provider);
      provider.failNext(HttpError.unavailable("The assistant is not available right now."));

      const response = await send("/agent/scribe/run", readerId, runInput("Hello there."));

      expect(response).toMatchObject({ status: 200, streamed: true });
      expect(response.events.find((event) => event["type"] === "RUN_ERROR")).toMatchObject({
        code: "service_unavailable",
        message: "The assistant is not available right now.",
      });
      expect(types(response.events)).not.toContain("RUN_FINISHED");
    });
  });
});
