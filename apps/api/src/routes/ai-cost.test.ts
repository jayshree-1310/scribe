/**
 * Cost and performance (Task AI 18): usage is persisted, the budget is
 * enforced before the call on every feature, cache hits are free, routing
 * picks the configured model, and administrators can read spend back.
 *
 * Usage persistence and the result cache are off for the rest of the suite
 * (`vitest.config.ts`); this file turns both on for itself and removes the
 * rows it wrote -- usage rows belong to no fixture the harness sweeps.
 */

/** See `ai.test.ts`: `lib/redis.ts` reads `REDIS_URL` at module scope. */
import "dotenv/config";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../lib/http-error.js";
import { connectRedis, redis } from "../lib/redis.js";
import { db } from "../prisma/db.js";
import { dailyBudgetKey } from "../services/ai/budget.js";
import { runAs } from "../services/ai/caller.js";
import { loadAiConfig } from "../services/ai/config.js";
import {
  __wrapForTests,
  aiProvider,
  modelFor,
  resetAiProvider,
  setAiProvider,
} from "../services/ai/provider.js";
import { fakeAiProvider, type FakeAiProvider } from "../services/ai/testing.js";
import { flushUsage } from "../services/ai/usage.js";
import { TestApi, databaseAvailable } from "../test/harness.js";

const api = new TestApi();
const available = await databaseAvailable();

const ENV = ["AI_USAGE_PERSIST", "AI_RESULT_CACHE_SECONDS", "AI_DAILY_TOKEN_BUDGET", "AI_FEATURE_MODELS"] as const;
const saved: Record<string, string | undefined> = {};

let caller: string;
let admin: string;
let chapterId: string;
/** Unique per run, so the explain cache key is fresh. */
const PASSAGE = `The keeper ${Date.now()} found the lamp cold and the door unbarred.`;

let fake: FakeAiProvider;

beforeAll(async () => {
  if (!available) return;
  for (const name of ENV) saved[name] = process.env[name];
  await api.start();

  caller = await api.createUser("cc");
  admin = await api.createUser("ca");
  await api.setAdmin(admin);
  const author = await api.createUser("cw", { isAuthor: true });
  const story = await api.createStory({ title: "Costed Story", authorId: author });
  chapterId = await api.createChapter({ storyId: story.id, number: 1, content: PASSAGE });
});

afterAll(async () => {
  if (!available) return;
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  await flushUsage();
  for (const userId of [caller, admin]) {
    await db.runtime().query(
      db.raw.sql`DELETE FROM "ai"."usageEvent" WHERE "userId" = ${userId}`.affectedCount().build(),
    );
  }
  resetAiProvider();
  await api.stop();
});

beforeEach(async () => {
  if (!available) return;
  process.env["AI_USAGE_PERSIST"] = "on";
  process.env["AI_RESULT_CACHE_SECONDS"] = "3600";
  delete process.env["AI_FEATURE_MODELS"];
  delete process.env["AI_DAILY_TOKEN_BUDGET"];
  fake = fakeAiProvider(["A reply."]);
  setAiProvider(fake);

  await connectRedis();
  for (const id of [caller, admin]) {
    await redis.del(dailyBudgetKey(id));
    for (const key of await redis.keys(`ai:*:${id}`)) await redis.del(key);
  }
});

afterEach(() => {
  resetAiProvider();
});

async function usageRows(userId: string) {
  await flushUsage();
  return db.orm.ai.UsageEvent.select("feature", "kind", "outcome", "errorCode", "inputTokens", "outputTokens", "model")
    .where((row) => row.userId.eq(userId))
    .all();
}

describe.skipIf(!available)("usage is persisted", () => {
  it("writes a row for a success and for a failure, attributed to the caller", async () => {
    // The real wrapping policy around the fake: retries and usage recording.
    setAiProvider(__wrapForTests(fake, { ...loadAiConfig(), maxRetries: 0 }));
    fake.failNext(HttpError.upstream("The model could not complete that request."));

    await runAs(caller, async () => {
      await expect(
        aiProvider().complete({ feature: "test.cost", system: "s", messages: [{ role: "user", content: "secret words" }] }),
      ).rejects.toThrow();
      await aiProvider().complete({ feature: "test.cost", system: "s", messages: [{ role: "user", content: "secret words" }] });
    });

    const rows = await usageRows(caller);
    expect(rows.map((row) => [row.feature, row.kind, row.outcome, row.errorCode]).sort()).toEqual([
      ["test.cost", "chat", "error", "upstream_error"],
      ["test.cost", "chat", "ok", null],
    ]);
    const ok = rows.find((row) => row.outcome === "ok");
    expect(ok?.outputTokens).toBeGreaterThan(0);
    // Ids, counts and outcomes only: the row has nowhere to put a prompt.
    expect(JSON.stringify(rows)).not.toContain("secret words");
  });

  it("attributes a route's calls to the signed-in caller", async () => {
    setAiProvider(__wrapForTests(fake, loadAiConfig()));

    const response = await api.request("/api/ai/chat", { method: "POST", as: caller, body: { prompt: "Hello there" } });
    expect(response.status).toBe(200);

    expect((await usageRows(caller)).map((row) => row.feature)).toContain("chat");
  });
});

describe.skipIf(!available)("the budget", () => {
  it("refuses a caller over budget before any provider call, on a route that never checked it itself", async () => {
    process.env["AI_DAILY_TOKEN_BUDGET"] = "100";
    await redis.set(dailyBudgetKey(caller), "500", { EX: 600 });

    const response = await api.request("/api/ai/assist", {
      method: "POST",
      as: caller,
      body: { action: "grammar", text: "She climb the stair." },
    });

    expect(response.status).toBe(429);
    expect(fake.calls).toHaveLength(0);
  });

  it("charges what the call cost, once, after it", async () => {
    process.env["AI_DAILY_TOKEN_BUDGET"] = "100000";

    const response = await api.request("/api/ai/assist", {
      method: "POST",
      as: caller,
      body: { action: "grammar", text: "She climb the stair." },
    });
    expect(response.status).toBe(200);

    // The fake reports 10 input tokens and ceil(length / 4) output tokens.
    const charged = Number(await redis.get(dailyBudgetKey(caller)));
    expect(charged).toBe(10 + Math.ceil("A reply.".length / 4));
  });

  it("never charges or refuses the platform's own work", async () => {
    process.env["AI_DAILY_TOKEN_BUDGET"] = "1";
    await runAs(null, () => aiProvider().complete({ feature: "moderation.classify", system: "s", messages: [] }));
    expect(fake.calls).toHaveLength(1);
  });
});

describe.skipIf(!available)("the result cache", () => {
  it("serves a repeated explanation without calling the provider, and charges nothing for it", async () => {
    const start = PASSAGE.indexOf("the lamp cold");
    const body = { chapterId, start, end: start + "the lamp cold".length, mode: "explain" };

    const first = await api.request<{ text: string; tokensUsed?: number }>("/api/ai/explain", {
      method: "POST",
      as: caller,
      body,
    });
    const second = await api.request<{ text: string }>("/api/ai/explain", { method: "POST", as: caller, body });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.text).toBe(first.body.text);
    expect(fake.calls).toHaveLength(1);

    // A different mode is a different question: a miss.
    await api.request("/api/ai/explain", { method: "POST", as: caller, body: { ...body, mode: "define" } });
    expect(fake.calls).toHaveLength(2);
  });
});

describe.skipIf(!available)("routing", () => {
  it("sends a feature to its configured model, longest prefix first, and leaves an explicit model alone", async () => {
    process.env["AI_FEATURE_MODELS"] = "assist=small-model, assist.tone=tone-model";

    await api.request("/api/ai/assist", { method: "POST", as: caller, body: { action: "grammar", text: "She climb." } });
    await api.request("/api/ai/assist", {
      method: "POST",
      as: caller,
      body: { action: "tone", tone: "wry", text: "She climbed." },
    });

    expect(fake.calls.map((call) => call.model)).toEqual(["small-model", "tone-model"]);

    const models = { assist: "small-model" };
    expect(modelFor({ feature: "assist.grammar", system: "", messages: [], model: "chosen" }, models)).toBe("chosen");
    expect(modelFor({ feature: "assistant", system: "", messages: [] }, models)).toBeUndefined();
  });
});

describe.skipIf(!available)("GET /api/ai/admin/spend", () => {
  it("is for administrators only", async () => {
    const response = await api.request("/api/ai/admin/spend", { as: caller });
    expect(response.status).toBe(403);
  });

  it("reports spend by feature, model and caller", async () => {
    setAiProvider(__wrapForTests(fake, loadAiConfig()));
    await api.request("/api/ai/chat", { method: "POST", as: caller, body: { prompt: "Count me" } });
    await flushUsage();

    const response = await api.request<{
      days: number;
      total: { calls: number };
      byFeature: { feature: string; calls: number }[];
      byModel: { model: string }[];
      topCallers: { userId: string; username: string | null; calls: number }[];
    }>("/api/ai/admin/spend?days=1", { as: admin });

    expect(response.status).toBe(200);
    expect(response.body.days).toBe(1);
    expect(response.body.total.calls).toBeGreaterThan(0);
    expect(response.body.byFeature.some((line) => line.feature === "chat" && line.calls > 0)).toBe(true);
    expect(response.body.byModel.length).toBeGreaterThan(0);
    const me = response.body.topCallers.find((line) => line.userId === caller);
    // Ten heaviest only, and the dev database may hold heavier callers.
    if (me) expect(me.username).toContain(api.runId.slice(0, 10));

    expect((await api.request("/api/ai/admin/spend?days=3", { as: admin })).status).toBe(400);
  });
});
