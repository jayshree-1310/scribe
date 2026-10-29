/**
 * Production AI infrastructure (Task AI 20): the job queue's retries and dead
 * letters, idempotent handlers, job status for its owner only, `/health`
 * staying green with the provider down, the kill switch, and request ids that
 * tie a user action to its provider calls.
 *
 * The suite runs on a queue of its own (`AI_JOBS_QUEUE`), so a dev server's
 * worker on the same Redis never sees these jobs, and removes it at the end.
 */

/** See `ai.test.ts`: `lib/redis.ts` reads `REDIS_URL` at module scope. */
import "dotenv/config";

import pino from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../lib/http-error.js";
import {
  deadJobs,
  drainJobs,
  enqueue,
  getJob,
  registerJobType,
  retryDeadJob,
  runNextJob,
} from "../lib/jobs.js";
import { logger } from "../lib/logger.js";
import { connectRedis, redis } from "../lib/redis.js";
import { db } from "../prisma/db.js";
import { loadAiConfig } from "../services/ai/config.js";
import { resetAiHealth } from "../services/ai/health.js";
import { isContinuityCheckPending } from "../services/ai/continuity-queue.js";
import { CONTINUITY_CHECK_JOB, EMBED_CHAPTER_JOB } from "../services/ai/job-schedule.js";
import { registerAiJobs } from "../services/ai/jobs.js";
import {
  __wrapForTests,
  resetAiEmbedder,
  resetAiProvider,
  setAiEmbedder,
  setAiProvider,
} from "../services/ai/provider.js";
import { resetSwitchCache, setFeature } from "../services/ai/switches.js";
import { fakeAiEmbedder, fakeAiProvider, type FakeAiProvider } from "../services/ai/testing.js";
import { TestApi, databaseAvailable } from "../test/harness.js";

const api = new TestApi();
const available = await databaseAvailable();
const QUEUE = `test-jobs-${api.runId}`;

const ENV = ["AI_JOBS", "AI_JOBS_QUEUE", "AI_USAGE_PERSIST"] as const;
const saved: Record<string, string | undefined> = {};

let author: string;
let reader: string;
let admin: string;
let fake: FakeAiProvider;

/** Every delayed job, due now: retries are scheduled seconds ahead. */
async function makeDue(): Promise<void> {
  for (const id of await redis.zRange(`${QUEUE}:delayed`, 0, -1)) {
    await redis.zAdd(`${QUEUE}:delayed`, { score: 0, value: id });
  }
}

beforeAll(async () => {
  if (!available) return;
  for (const name of ENV) saved[name] = process.env[name];
  process.env["AI_JOBS"] = "on";
  process.env["AI_JOBS_QUEUE"] = QUEUE;
  await api.start();
  await connectRedis();
  registerAiJobs();

  author = await api.createUser("oa", { isAuthor: true });
  reader = await api.createUser("or");
  admin = await api.createUser("od");
  await api.setAdmin(admin);
});

afterAll(async () => {
  if (!available) return;
  for (const key of await redis.keys(`${QUEUE}:*`)) await redis.del(key);
  await setFeature("test-switch", true);
  await setFeature("assist", true);
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  resetAiProvider();
  resetAiEmbedder();
  await api.stop();
});

beforeEach(async () => {
  if (!available) return;
  fake = fakeAiProvider(["A reply."]);
  setAiProvider(fake);
  setAiEmbedder(fakeAiEmbedder(768, { model: "fake-ops" }));
  resetAiHealth();
  resetSwitchCache();
  for (const id of [author, reader, admin]) {
    for (const key of await redis.keys(`ai:*:${id}`)) await redis.del(key);
  }
});

afterEach(() => {
  resetAiProvider();
  resetAiEmbedder();
});

describe.skipIf(!available)("the job queue", () => {
  it("retries a failing job with backoff, then succeeds", async () => {
    let calls = 0;
    registerJobType("test.flaky", {
      maxAttempts: 3,
      async handler() {
        calls += 1;
        if (calls < 3) throw HttpError.unavailable("not yet");
        return { calls };
      },
    });

    const id = await enqueue("test.flaky", {});
    await drainJobs();
    expect((await getJob(id))?.status).toBe("failed");
    // Not retried at once: the backoff put it in the future.
    expect(await runNextJob()).toBe(false);

    await makeDue();
    await drainJobs();
    await makeDue();
    await drainJobs();

    const job = await getJob(id);
    expect(job).toMatchObject({ status: "done", attempts: 3, error: null, result: { calls: 3 } });
  });

  it("dead-letters a job that keeps failing, and a person can retry it", async () => {
    let fail = true;
    registerJobType("test.broken", {
      maxAttempts: 2,
      async handler() {
        if (fail) throw HttpError.upstream("still broken");
        return "fixed";
      },
    });

    const id = await enqueue("test.broken", {});
    await drainJobs();
    await makeDue();
    await drainJobs();

    expect(await getJob(id)).toMatchObject({ status: "dead", attempts: 2, error: "upstream_error" });
    expect((await deadJobs()).map((job) => job.id)).toContain(id);

    fail = false;
    expect(await retryDeadJob(id)).toBe(true);
    await drainJobs();
    expect(await getJob(id)).toMatchObject({ status: "done", result: "fixed" });
    expect((await deadJobs()).map((job) => job.id)).not.toContain(id);
  });

  it("debounces by key: enqueueing again while waiting is the same job, later", async () => {
    registerJobType("test.debounced", { maxAttempts: 1, handler: async () => "ran" });

    const first = await enqueue("test.debounced", {}, { dedupeKey: "same", delayMs: 60_000 });
    const second = await enqueue("test.debounced", {}, { dedupeKey: "same", delayMs: 120_000 });
    expect(second).toBe(first);
    expect(await redis.zScore(`${QUEUE}:delayed`, first)).toBeGreaterThan(Date.now() + 90_000);
  });

  it("dead-letters a job of a type this worker does not know, rather than losing it", async () => {
    const id = await enqueue("test.nobody-handles-this", {});
    await drainJobs();
    expect(await getJob(id)).toMatchObject({ status: "dead", error: "unknown_job_type" });
  });
});

describe.skipIf(!available)("idempotent handlers", () => {
  it("embeds a published chapter once, however many times the job runs, and skips a draft", async () => {
    const story = await api.createStory({ title: "Indexed Story", authorId: author });
    const draft = await api.createStory({ title: "Unlisted Story", authorId: author, listed: false });
    const text = "The keeper climbed the stair and found the lamp cold. ".repeat(20);
    const chapter = await api.createChapter({ storyId: story.id, number: 1, content: text });
    const hidden = await api.createChapter({ storyId: draft.id, number: 1, content: text });

    const first = await enqueue(EMBED_CHAPTER_JOB, { chapterId: chapter });
    const second = await enqueue(EMBED_CHAPTER_JOB, { chapterId: chapter });
    const skipped = await enqueue(EMBED_CHAPTER_JOB, { chapterId: hidden });
    await drainJobs();

    const rows = async (chapterId: string) => {
      const [row] = (await db.runtime().query(
        db.raw.sql`SELECT COUNT(*)::int AS "n" FROM "ai"."chapterChunk" WHERE "chapterId" = ${chapterId}`
          .returnsRow({ n: "pg/int4@1" })
          .build(),
      )) as { n: number }[];
      return row?.n ?? 0;
    };

    const once = await rows(chapter);
    expect(once).toBeGreaterThan(0);
    expect((await getJob(first))?.status).toBe("done");
    expect((await getJob(second))?.status).toBe("done");
    // The second run found nothing changed and wrote nothing new.
    expect(await rows(chapter)).toBe(once);
    expect((await getJob(skipped))?.result).toEqual({ skipped: "unpublished" });
    expect(await rows(hidden)).toBe(0);
  });

  it("queues the embedding when an author publishes a chapter", async () => {
    const story = await api.createStory({ title: "Published Story", authorId: author });
    const chapterId = await api.createChapter({
      storyId: story.id,
      number: 1,
      content: "Mira counted the steps. ".repeat(30),
      published: false,
    });

    const response = await api.request(`/api/author/chapters/${chapterId}/publish`, { method: "POST", as: author });
    expect(response.status).toBe(200);

    // Fire-and-forget from the publish; give the enqueue a moment to land.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await drainJobs();
    const [row] = (await db.runtime().query(
      db.raw.sql`SELECT COUNT(*)::int AS "n" FROM "ai"."chapterChunk" WHERE "chapterId" = ${chapterId}`
        .returnsRow({ n: "pg/int4@1" })
        .build(),
    )) as { n: number }[];
    expect(row?.n ?? 0).toBeGreaterThan(0);
  });
});

describe.skipIf(!available)("job status", () => {
  it("is readable by the person who caused it, and nobody else", async () => {
    const story = await api.createStory({ title: "Bible Job Story", authorId: author });
    await api.createChapter({ storyId: story.id, number: 1, content: "Kit wore a red coat to the harbour." });
    fake = fakeAiProvider([JSON.stringify({ facts: [] })]);
    setAiProvider(fake);

    const started = await api.request<{ jobId: string }>(`/api/ai/bible/${story.id}/read`, { method: "POST", as: author });
    expect(started.status).toBe(202);

    const mine = await api.request<{ status: string }>(`/api/ai/jobs/${started.body.jobId}`, { as: author });
    expect(mine.status).toBe(200);
    expect(mine.body.status).toBe("queued");
    expect((await api.request(`/api/ai/jobs/${started.body.jobId}`, { as: reader })).status).toBe(404);

    // Someone else's story is refused before anything is queued.
    expect((await api.request(`/api/ai/bible/${story.id}/read`, { method: "POST", as: reader })).status).toBe(403);

    await makeDue();
    await drainJobs();
    const done = await api.request<{ status: string; result: { pending: number } }>(
      `/api/ai/jobs/${started.body.jobId}`,
      { as: author },
    );
    expect(done.body).toMatchObject({ status: "done", result: { pending: 0 } });
  });
});

describe.skipIf(!available)("keeping a story bible current", () => {
  /** Edits a chapter the way the editor's autosave does. */
  const save = (chapterId: string, content: string) =>
    api.request(`/api/author/chapters/${chapterId}`, {
      method: "PATCH",
      as: author,
      body: { content },
    });

  it("re-reads an edited chapter of a story whose author built a bible", async () => {
    const story = await api.createStory({ title: "Kept Bible", authorId: author });
    const chapter = await api.createChapter({ storyId: story.id, number: 1, content: "Kit wore a red coat." });

    // The author builds it once, by hand.
    fake = fakeAiProvider([JSON.stringify({ facts: [] })]);
    setAiProvider(fake);
    expect((await api.request(`/api/ai/bible/${story.id}/refresh`, { method: "POST", as: author })).status).toBe(200);

    // Then only writes: the save queues the read, which runs after a quiet spell.
    fake = fakeAiProvider([JSON.stringify({ facts: [] })]);
    setAiProvider(fake);
    expect((await save(chapter, "Kit wore a blue coat now, and kept it.")).status).toBe(200);
    expect(fake.calls).toHaveLength(0);

    await makeDue();
    await drainJobs();

    expect(fake.calls).toHaveLength(1);
    expect(String(fake.calls[0]?.messages[0]?.content)).toContain("blue coat");
  });

  it("queues a continuity check that outlives the process: one job per burst of saves", async () => {
    const was = process.env["AI_CONTINUITY"];
    process.env["AI_CONTINUITY"] = "on";
    try {
      const story = await api.createStory({ title: "Checked On The Queue", authorId: author });
      const chapter = await api.createChapter({ storyId: story.id, number: 1, content: "Kit wore a red coat." });
      fake = fakeAiProvider([JSON.stringify({ facts: [] })]);
      setAiProvider(fake);
      await api.request(`/api/ai/bible/${story.id}/refresh`, { method: "POST", as: author });

      await save(chapter, "Kit wore a blue coat.");
      await save(chapter, "Kit wore a blue coat, and kept it.");

      // Not an in-memory timer a restart would drop...
      expect(isContinuityCheckPending(chapter)).toBe(false);
      // ...but one waiting job, pushed back by the second save.
      const waiting = (
        await Promise.all((await redis.zRange(`${QUEUE}:delayed`, 0, -1)).map((id) => getJob(id)))
      ).filter((job) => job?.type === CONTINUITY_CHECK_JOB && job.payload["chapterId"] === chapter);
      expect(waiting).toHaveLength(1);

      await makeDue();
      await drainJobs();
      expect((await getJob(waiting[0]!.id))?.status).toBe("done");
    } finally {
      if (was === undefined) delete process.env["AI_CONTINUITY"];
      else process.env["AI_CONTINUITY"] = was;
    }
  });

  it("leaves a story with no bible alone, and charges its author nothing", async () => {
    const story = await api.createStory({ title: "No Bible", authorId: author });
    const chapter = await api.createChapter({ storyId: story.id, number: 1, content: "Kit wore a red coat." });

    expect((await save(chapter, "Kit wore a green coat.")).status).toBe(200);
    await makeDue();
    await drainJobs();

    expect(fake.calls).toHaveLength(0);
  });
});

describe.skipIf(!available)("degradation", () => {
  it("keeps /health green with the provider down, and says it is degraded", async () => {
    const failing = fakeAiProvider(["ok"]);
    failing.failNext(HttpError.unavailable("The model service is unreachable."));
    setAiProvider(__wrapForTests(failing, { ...loadAiConfig(), maxRetries: 0 }));

    const call = await api.request("/api/ai/chat", { method: "POST", as: reader, body: { prompt: "Hello" } });
    expect(call.status).toBe(503);

    const health = await api.request<{ status: string; ai: { status: { chat: { state: string; lastError?: string } } } }>(
      "/health",
    );
    expect(health.status).toBe(200);
    expect(health.body.status).toBe("ok");
    expect(health.body.ai.status.chat).toEqual({ state: "degraded", lastError: "service_unavailable" });

    // And the rest of the app does not notice.
    expect((await api.request("/api/stories")).status).toBe(200);
  });

  it("switches a feature off without a deploy, and on again", async () => {
    expect(
      (await api.request("/api/ai/admin/switches", { method: "PUT", as: reader, body: { feature: "assist", enabled: false } }))
        .status,
    ).toBe(403);

    const off = await api.request<{ switchedOff: string[] }>("/api/ai/admin/switches", {
      method: "PUT",
      as: admin,
      body: { feature: "assist", enabled: false },
    });
    expect(off.body.switchedOff).toContain("assist");

    const refused = await api.request<{ error: { message: string } }>("/api/ai/assist", {
      method: "POST",
      as: reader,
      body: { action: "grammar", text: "She climb." },
    });
    expect(refused.status).toBe(503);
    expect(refused.body.error.message).toContain("switched off");
    expect(fake.calls).toHaveLength(0);

    // Another feature is untouched.
    expect((await api.request("/api/ai/chat", { method: "POST", as: reader, body: { prompt: "Hi" } })).status).toBe(200);

    await api.request("/api/ai/admin/switches", { method: "PUT", as: admin, body: { feature: "assist", enabled: true } });
    expect(
      (await api.request("/api/ai/assist", { method: "POST", as: reader, body: { action: "grammar", text: "She climb." } }))
        .status,
    ).toBe(200);
  });

  it("shows an administrator the queue, the dead letters, health and the switches", async () => {
    const response = await api.request<{ queue: object; dead: unknown[]; health: object; switchedOff: string[] }>(
      "/api/ai/admin/ops",
      { as: admin },
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ queue: { ready: expect.any(Number), dead: expect.any(Number) } });
    expect(Array.isArray(response.body.dead)).toBe(true);
    expect((await api.request("/api/ai/admin/ops", { as: reader })).status).toBe(403);
  });
});

describe.skipIf(!available)("observability", () => {
  it("ties a request's log line to the provider calls it made, by request id", async () => {
    setAiProvider(__wrapForTests(fake, loadAiConfig()));

    const stream = (logger as unknown as Record<symbol, { write: (chunk: string) => boolean }>)[pino.symbols.streamSym]!;
    const write = stream.write;
    const level = logger.level;
    const lines: string[] = [];
    stream.write = (chunk: string) => {
      lines.push(chunk);
      return true;
    };
    logger.level = "info";
    try {
      await api.request("/api/ai/chat", { method: "POST", as: reader, body: { prompt: "Trace me" } });
    } finally {
      stream.write = write;
      logger.level = level;
    }

    const parsed = lines.map((line) => JSON.parse(line) as { msg?: string; req?: { id?: unknown; url?: string }; ai?: { requestId?: unknown } });
    const usage = parsed.find((line) => line.msg === "AI call");
    const request = parsed.find((line) => line.req?.url === "/api/ai/chat");
    expect(usage?.ai?.requestId).toBeTruthy();
    expect(String(usage?.ai?.requestId)).toBe(String(request?.req?.id));
  });
});
