/**
 * Story summaries (Task AI 6): map-reduce over chapter summaries, spoiler-free
 * by construction, cached by input hash, generated off the request path.
 *
 * The four the task names: unchanged content does not regenerate; a changed
 * chapter invalidates its summary; a spoiler-free summary never receives
 * later chapters (asserted on what the fake was sent); and the reduce runs
 * over summaries, not bodies. Plus long chapters being map-reduced instead of
 * cut, and the author's regenerate.
 */

/** See `ai.test.ts`: `lib/redis.ts` reads `REDIS_URL` at module scope. */
import "dotenv/config";

import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drainJobs } from "../lib/jobs.js";
import { connectRedis, redis } from "../lib/redis.js";
import { db } from "../prisma/db.js";
import { registerAiJobs } from "../services/ai/jobs.js";
import { resetAiProvider, setAiProvider } from "../services/ai/provider.js";
import { CHAPTER_LIMIT, ensureChapterSummary, getChapterRecap } from "../services/ai/recap.js";
import { generateStorySummary } from "../services/ai/summaries.js";
import { fakeAiProvider, type FakeAiProvider } from "../services/ai/testing.js";
import type { AiRequest } from "../services/ai/types.js";
import { TestApi, databaseAvailable } from "../test/harness.js";

const api = new TestApi();
const available = await databaseAvailable();
const QUEUE = `test-summaries-${api.runId}`;

const ONE = "Mira climbed the lighthouse stair and found the lamp cold.";
const TWO = "Someone knocked three times on the door below.";
const THREE = "In the end the keeper was the killer all along.";

const ENV = ["AI_JOBS", "AI_JOBS_QUEUE"] as const;
const saved: Record<string, string | undefined> = {};

let author: string;
let reader: string;
let story: { id: string; slug: string };
const chapters: string[] = [];
let fake: FakeAiProvider;

const sent = (call: { messages: AiRequest["messages"] }) => call.messages.map((message) => message.content).join("\n");

/** Answers each step with something traceable to its input. */
function model(request: AiRequest): string | undefined {
  const text = sent(request);
  switch (request.feature) {
    case "recap.chapter":
      // The title, plus the length of what was read: an edit changes it.
      return `SUMMARY OF ${/Title: ([^\n]+)/.exec(text)?.[1] ?? "?"} (${text.length})`;
    case "recap.chapter.section":
      return `SECTION ${/\(part (\d+) of/.exec(text)?.[1] ?? "?"}`;
    case "recap.chapter.combine":
      return "COMBINED RECAP";
    case "summary.story":
      return `STORY SO FAR (${(text.match(/^Chapter \d+|^Chapters \d+–\d+/gm) ?? []).join(", ")})`;
    default:
      return undefined;
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

  author = await api.createUser("ma", { isAuthor: true });
  reader = await api.createUser("mr");
  story = await api.createStory({ title: "Summarised Story", authorId: author });
  for (const [index, content] of [ONE, TWO, THREE].entries()) {
    chapters.push(await api.createChapter({ storyId: story.id, number: index + 1, title: `Part ${index + 1}`, content }));
  }
});

afterAll(async () => {
  if (!available) return;
  for (const key of await redis.keys(`${QUEUE}:*`)) await redis.del(key);
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  resetAiProvider();
  await api.stop();
});

beforeEach(async () => {
  if (!available) return;
  fake = fakeAiProvider(["unused"], { respond: model });
  setAiProvider(fake);
  // Each test starts with an empty queue: a stale read in one queues a job
  // that would otherwise run inside the next one's assertions.
  await drainJobs();
  fake.reset();
  for (const id of [author, reader]) {
    for (const key of await redis.keys(`ai:*:${id}`)) await redis.del(key);
  }
});

afterEach(() => resetAiProvider());

interface Status {
  available: boolean;
  scope: { upToChapter: number | null; basis: string };
  summary: { text: string; upToChapter: number; kind: string; chapterCount: number } | null;
  generating: boolean;
}

const read = (as: string, upTo?: number) =>
  api.request<Status>(`/api/ai/summaries/story/${story.slug}${upTo ? `?upToChapter=${upTo}` : ""}`, { as });

describe.skipIf(!available)("story summaries", () => {
  it("queues a reader's missing summary, then serves it, bounded to where they have read", async () => {
    const first = await read(reader);
    expect(first.status).toBe(200);
    // No saved position: the opening chapter only, as Ask This Book bounds it.
    expect(first.body).toMatchObject({ available: true, scope: { basis: "start", upToChapter: 1 }, summary: null, generating: true });
    expect(fake.calls).toHaveLength(0); // A read never calls a model.

    await drainJobs();
    const second = await read(reader);
    expect(second.body.summary).toMatchObject({ upToChapter: 1, kind: "spoiler_free", chapterCount: 1, text: "STORY SO FAR (Chapter 1)" });
  });

  it("never sends a spoiler-free summary anything past its chapter, and reduces summaries, not bodies", async () => {
    await read(reader, 2);
    await drainJobs();
    const status = await read(reader, 2);
    expect(status.body.summary?.upToChapter).toBe(2);

    const everything = fake.calls.map(sent).join("\n");
    expect(everything).not.toContain(THREE);
    expect(everything).not.toContain("Part 3");

    const reduce = fake.calls.find((call) => call.feature === "summary.story")!;
    expect(sent(reduce)).toContain("SUMMARY OF Part 1");
    expect(sent(reduce)).toContain("SUMMARY OF Part 2");
    // The bodies reached the map step only.
    expect(sent(reduce)).not.toContain(ONE);
    expect(sent(reduce)).not.toContain(TWO);
  });

  it("gives the author the whole story", async () => {
    await read(author);
    await drainJobs();
    const status = await read(author);
    expect(status.body.scope.basis).toBe("author");
    expect(status.body.summary).toMatchObject({ upToChapter: 3, kind: "story", chapterCount: 3 });
  });

  it("does not regenerate unchanged content", async () => {
    await generateStorySummary(story.id, null);
    fake.reset();

    const again = await generateStorySummary(story.id, null);
    expect(again.calls).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });

  it("invalidates a summary when a chapter it covers changes, and rewrites only that chapter", async () => {
    await generateStorySummary(story.id, null);
    await db.orm.content.Chapter.where((row) => row.id.eq(chapters[1]!)).update({
      content: `${TWO} Then the door opened.`,
    });

    // Stale is absent: the old paragraph describes prose that is gone.
    const stale = await read(author);
    expect(stale.body.summary).toBeNull();

    fake.reset();
    const regenerated = await generateStorySummary(story.id, null);
    expect(fake.calls.map((call) => call.feature).sort()).toEqual(["recap.chapter", "summary.story"]);
    expect(sent(fake.calls.find((call) => call.feature === "recap.chapter")!)).toContain("Then the door opened");
    expect(regenerated.calls).toBe(2);
  });

  it("lets only the author regenerate, in the background, and forces a fresh reduce", async () => {
    expect((await api.request(`/api/ai/summaries/story/${story.id}/regenerate`, { method: "POST", as: reader })).status).toBe(403);

    await generateStorySummary(story.id, null);
    fake.reset();
    const started = await api.request<{ jobId: string }>(`/api/ai/summaries/story/${story.id}/regenerate`, {
      method: "POST",
      as: author,
    });
    expect(started.status).toBe(202);
    await drainJobs();

    // Chapter summaries were current; only the reduce ran again.
    expect(fake.calls.map((call) => call.feature)).toEqual(["summary.story"]);
    const job = await api.request<{ status: string }>(`/api/ai/jobs/${started.body.jobId}`, { as: author });
    expect(job.body.status).toBe("done");
  });

  it("lets the author regenerate one chapter's summary on demand", async () => {
    await ensureChapterSummary({ id: chapters[0]!, title: "Part 1", content: ONE });
    fake.reset();

    const response = await api.request<{ text: string }>(`/api/ai/summaries/chapter/${chapters[0]}/regenerate`, {
      method: "POST",
      as: author,
    });
    expect(response.status).toBe(200);
    expect(fake.calls).toHaveLength(1); // Forced, though the stored one was current.
    expect((await api.request(`/api/ai/summaries/chapter/${chapters[0]}/regenerate`, { method: "POST", as: reader })).status).toBe(403);
  });
});

describe.skipIf(!available)("chapter summaries", () => {
  it("map-reduces a chapter too long for one call instead of cutting it", async () => {
    const paragraph = "The tide came in over the causeway and the keeper counted the bells. ".repeat(40);
    const long = Array.from({ length: Math.ceil((CHAPTER_LIMIT * 2.5) / paragraph.length) }, () => paragraph).join("\n\n");
    const id = await api.createChapter({ storyId: story.id, number: 9, title: "The Long One", content: `${long}\n\nTHE LAST LINE.` });

    const summary = await ensureChapterSummary({ id, title: "The Long One", content: `${long}\n\nTHE LAST LINE.` });

    const sections = fake.calls.filter((call) => call.feature === "recap.chapter.section");
    expect(sections.length).toBeGreaterThanOrEqual(3);
    expect(summary).toMatchObject({ text: "COMBINED RECAP", truncated: false, calls: sections.length + 1 });
    // The ending was read -- by the last section, not cut off.
    expect(sent(sections.at(-1)!)).toContain("THE LAST LINE.");
    // The combine saw section summaries, not prose.
    const combine = fake.calls.find((call) => call.feature === "recap.chapter.combine")!;
    expect(sent(combine)).toContain("SECTION 1");
    expect(sent(combine)).not.toContain("causeway");
  });

  it("treats a recap written under an older prompt or hash as stale", async () => {
    await ensureChapterSummary({ id: chapters[0]!, title: "Part 1", content: ONE });
    // How version 1 hashed: the body alone, so a prompt bump changed nothing.
    await db.orm.ai.ChapterSummary.where((row) => row.chapterId.eq(chapters[0]!)).update({
      contentHash: createHash("sha256").update(ONE).digest("hex"),
    });

    const status = await getChapterRecap(story.slug, 2, reader);
    expect(status).toMatchObject({ available: true, recap: null });
  });
});
