import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestApi, databaseAvailable } from "../test/harness.js";
import { anchor, type Highlight } from "../services/highlights.js";
import type { StoryAnalytics } from "../services/analytics.js";

const api = new TestApi();
const available = await databaseAvailable();

let author: string;
let reader: string;
let other: string;
let storyId: string;
let chapterId: string;
let draftId: string;

const TEXT = [
  "The lamp went **cold** at midnight.",
  "",
  "She counted the stairs twice, and the lamp went cold again.",
  "",
  "Nobody answered the door.",
].join("\n");

beforeAll(async () => {
  if (!available) return;
  await api.start();

  author = await api.createUser("hlauth", { isAuthor: true });
  reader = await api.createUser("hlread");
  other = await api.createUser("hlother");

  const story = await api.createStory({ title: "Highlight fixture", authorId: author });
  storyId = story.id;
  chapterId = await api.createChapter({ storyId, number: 1, content: TEXT });
  draftId = await api.createChapter({ storyId, number: 2, content: "Draft text.", published: false });
}, 30_000);

afterAll(async () => {
  if (available) await api.stop();
});

function span(phrase: string, from = 0): { start: number; end: number } {
  const start = TEXT.indexOf(phrase, from);
  if (start === -1) throw new Error(`fixture text has no "${phrase}"`);
  return { start, end: start + phrase.length };
}

async function highlight(as: string, body: Record<string, unknown>) {
  return api.request<{ highlight: Highlight }>("/api/reading/highlights", {
    method: "POST",
    as,
    body: { chapterId, ...body },
  });
}

async function list(as: string) {
  const response = await api.request<{ highlights: Highlight[] }>(
    `/api/reading/highlights?storyId=${storyId}`,
    { as },
  );
  expect(response.status).toBe(200);
  return response.body.highlights;
}

async function setContent(content: string): Promise<void> {
  const { db } = await import("../prisma/db.js");
  await db.orm.content.Chapter.where((row) => row.id.eq(chapterId)).update({ content });
}

describe("anchor", () => {
  it("keeps the stored place while the text is still there", () => {
    expect(anchor("a cat and a cat", "cat", 12)).toEqual({ start: 12, end: 15 });
  });

  it("moves to the nearest occurrence when the text shifted", () => {
    expect(anchor("xx a cat and a cat", "cat", 12)).toEqual({ start: 15, end: 18 });
    expect(anchor("xx a cat and a cat", "cat", 3)).toEqual({ start: 5, end: 8 });
  });

  it("reports a passage that is gone", () => {
    expect(anchor("a dog", "cat", 2)).toBeNull();
  });
});

describe.skipIf(!available)("highlights", () => {
  it("cuts the quote from the chapter, not from the request", async () => {
    const response = await highlight(reader, {
      ...span("The lamp went **cold**"),
      quote: "something else entirely",
    });

    expect(response.status).toBe(201);
    expect(response.body.highlight).toMatchObject({
      chapterId,
      chapterNumber: 1,
      quote: "The lamp went **cold**",
      note: null,
      found: true,
    });
  });

  it("needs a reader", async () => {
    const response = await api.request("/api/reading/highlights", {
      method: "POST",
      body: { chapterId, ...span("Nobody") },
    });
    expect(response.status).toBe(401);
  });

  it("refuses a chapter the reader cannot open, and offsets outside the text", async () => {
    const draft = await api.request("/api/reading/highlights", {
      method: "POST",
      as: reader,
      body: { chapterId: draftId, start: 0, end: 5 },
    });
    expect(draft.status).toBe(404);

    const past = await highlight(reader, { start: TEXT.length - 2, end: TEXT.length + 10 });
    expect(past.status).toBe(400);

    const blank = await highlight(reader, { start: TEXT.indexOf("\n\n"), end: TEXT.indexOf("\n\n") + 2 });
    expect(blank.status).toBe(400);
  });

  it("returns the same highlight for the same span, and keeps notes private", async () => {
    const first = await highlight(reader, { ...span("Nobody answered"), note: "  ominous  " });
    const again = await highlight(reader, span("Nobody answered"));

    expect(first.status).toBe(201);
    expect(first.body.highlight.note).toBe("ominous");
    expect(again.body.highlight.id).toBe(first.body.highlight.id);
    expect(again.body.highlight.note).toBe("ominous");

    const id = first.body.highlight.id;
    expect(await list(other)).toEqual([]);

    for (const [method, body] of [
      ["PATCH", { note: "mine now" }],
      ["DELETE", undefined],
    ] as const) {
      const response = await api.request(`/api/reading/highlights/${id}`, {
        method,
        as: other,
        body,
      });
      expect(response.status).toBe(404);
    }

    const mine = await list(reader);
    expect(mine.find((row) => row.id === id)?.note).toBe("ominous");
  });

  it("edits, clears and bounds a note", async () => {
    const { body } = await highlight(reader, span("counted the stairs"));
    const id = body.highlight.id;

    const edited = await api.request<{ highlight: Highlight }>(
      `/api/reading/highlights/${id}`,
      { method: "PATCH", as: reader, body: { note: "twice!" } },
    );
    expect(edited.body.highlight.note).toBe("twice!");

    const cleared = await api.request<{ highlight: Highlight }>(
      `/api/reading/highlights/${id}`,
      { method: "PATCH", as: reader, body: { note: "   " } },
    );
    expect(cleared.body.highlight.note).toBeNull();

    const tooLong = await api.request(`/api/reading/highlights/${id}`, {
      method: "PATCH",
      as: reader,
      body: { note: "x".repeat(1001) },
    });
    expect(tooLong.status).toBe(400);

    const removed = await api.request(`/api/reading/highlights/${id}`, {
      method: "DELETE",
      as: reader,
    });
    expect(removed.status).toBe(204);
    expect((await list(reader)).some((row) => row.id === id)).toBe(false);
  });

  it("follows the passage through an edit and reports it once it is gone", async () => {
    const { body } = await highlight(reader, span("Nobody answered the door."));
    const id = body.highlight.id;

    const prefix = "A new opening line.\n\n";
    await setContent(prefix + TEXT);
    const moved = (await list(reader)).find((row) => row.id === id)!;
    expect(moved.found).toBe(true);
    expect(moved.start).toBe(prefix.length + TEXT.indexOf("Nobody answered the door."));

    await setContent(TEXT.replace("Nobody answered the door.", "The door opened."));
    const gone = (await list(reader)).find((row) => row.id === id)!;
    expect(gone.found).toBe(false);
    expect(gone.quote).toBe("Nobody answered the door.");

    await setContent(TEXT);
    const back = (await list(reader)).find((row) => row.id === id)!;
    expect(back.found).toBe(true);
    expect(back.start).toBe(TEXT.indexOf("Nobody answered the door."));
  });

  it("drops out of the list while the chapter is unpublished", async () => {
    const { db } = await import("../prisma/db.js");
    const before = await db.orm.content.Chapter.select("publishedAt")
      .where((row) => row.id.eq(chapterId))
      .first();

    await db.orm.content.Chapter.where((row) => row.id.eq(chapterId)).update({ publishedAt: null });
    expect(await list(reader)).toEqual([]);

    await db.orm.content.Chapter.where((row) => row.id.eq(chapterId)).update({
      publishedAt: before!.publishedAt,
    });
    expect((await list(reader)).length).toBeGreaterThan(0);
  });

  it("goes with the chapter when the author deletes it", async () => {
    const doomed = await api.createChapter({ storyId, number: 3, content: "Short-lived words." });
    const made = await api.request<{ highlight: Highlight }>("/api/reading/highlights", {
      method: "POST",
      as: reader,
      body: { chapterId: doomed, start: 0, end: 10, note: "gone soon" },
    });
    expect(made.status).toBe(201);

    const removed = await api.request(`/api/author/chapters/${doomed}`, {
      method: "DELETE",
      as: author,
    });
    expect(removed.status).toBe(200);

    const { db } = await import("../prisma/db.js");
    const left = await db.orm.engagement.Highlight.select("id")
      .where((row) => row.id.eq(made.body.highlight.id))
      .first();
    expect(left ?? null).toBeNull();
  });

  it("gives the author anonymous counts per paragraph, without notes or their own", async () => {
    await highlight(other, { ...span("the lamp went cold again"), note: "secret note" });
    await highlight(other, span("She counted"));
    await highlight(reader, span("the lamp went cold again"));
    await highlight(author, span("Nobody answered"));

    const response = await api.request<StoryAnalytics>(
      `/api/author/analytics/stories/${storyId}`,
      { as: author },
    );
    expect(response.status).toBe(200);

    const { highlights } = response.body;
    expect(highlights.readers).toBe(2);
    expect(highlights.passages[0]).toEqual({
      chapterId,
      chapterNumber: 1,
      chapterTitle: "Chapter 1",
      quote: "the lamp went cold again",
      readers: 2,
    });
    expect(JSON.stringify(highlights)).not.toContain("secret note");
    expect(JSON.stringify(highlights)).not.toContain(reader);

    const stranger = await api.request(`/api/author/analytics/stories/${storyId}`, {
      as: other,
    });
    expect(stranger.status).toBe(404);
  });
});
