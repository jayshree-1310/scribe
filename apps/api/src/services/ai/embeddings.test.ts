/**
 * The embedding pass, against the real database and a fake embedder.
 *
 * Nearly every assertion here is about **work not done**: how many times the
 * embedder was called, and for which chunks. That is the whole subject of Task
 * AI 7 — the vectors themselves are the model's business, and asserting on
 * them would be asserting on a model.
 *
 * The fake answers at 768 dimensions because the column is `vector(768)`. A
 * narrower fake would fail in Postgres rather than in the service, which is a
 * true statement about the schema and a useless test of this file.
 */

/** See `routes/ai.test.ts`: `lib/redis.ts` reads `REDIS_URL` at module scope. */
import "dotenv/config";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { db } from "../../prisma/db.js";
import { TestApi, databaseAvailable } from "../../test/harness.js";
import { chunkChapter } from "./chunking.js";
import { deleteChunks, embedChapter } from "./embeddings.js";
import { resetAiEmbedder, setAiEmbedder } from "./provider.js";
import { fakeAiEmbedder, type FakeAiEmbedder } from "./testing.js";

const api = new TestApi();
const available = await databaseAvailable();

/** Long enough to chunk into several windows; distinguishable per paragraph. */
function chapterProse(marker: string, paragraphs = 10): string {
  return Array.from(
    { length: paragraphs },
    (_, index) =>
      `${marker} paragraph ${index}. ` +
      "The lamp room was cold and the stair was long and nobody had come up it since the tide turned. ".repeat(
        3,
      ),
  ).join("\n\n");
}

const ORIGINAL = chapterProse("Original");

let authorId: string;
let storyId: string;
let chapterId: string;
let embedder: FakeAiEmbedder;

/** Stored rows for the fixture chapter, in order. */
async function rows(): Promise<
  {
    ordinal: number;
    text: string;
    contentHash: string;
    model: string;
    dimensions: number;
  }[]
> {
  return db.orm.ai.ChapterChunk.select(
    "ordinal",
    "text",
    "contentHash",
    "model",
    "dimensions",
  )
    .where((row) => row.chapterId.eq(chapterId))
    .orderBy((row) => row.ordinal.asc())
    .all();
}

/** How many texts the embedder was asked for across every call. */
function embeddedTexts(): string[] {
  return embedder.calls.flatMap((call) => call.texts);
}

beforeAll(async () => {
  if (!available) return;
  await api.start();

  authorId = await api.createUser("embedder-author");
  const story = await api.createStory({ title: "The Lamp Room", authorId });
  storyId = story.id;

  chapterId = await api.createChapter({
    storyId,
    number: 1,
    title: "The cold lamp",
    content: ORIGINAL,
  });
});

afterAll(async () => {
  if (!available) return;
  await api.stop();
});

beforeEach(async () => {
  if (!available) return;

  embedder = fakeAiEmbedder(768);
  setAiEmbedder(embedder);

  await deleteChunks(chapterId);
  await db.orm.content.Chapter.where((row) => row.id.eq(chapterId)).update({
    content: ORIGINAL,
  });
});

afterEach(() => {
  resetAiEmbedder();
});

const chapter = (content = ORIGINAL) => ({ id: chapterId, storyId, content });

describe.runIf(available)("embedChapter", () => {
  it("stores one row per window, with the model and width that wrote it", async () => {
    const result = await embedChapter(chapter());
    const stored = await rows();
    const expected = chunkChapter(ORIGINAL);

    expect(expected.length).toBeGreaterThan(1);
    expect(result.chunks).toBe(expected.length);
    expect(result.embedded).toBe(expected.length);
    expect(result.reused).toBe(0);
    expect(result.unchanged).toBe(false);

    expect(stored.map((row) => row.ordinal)).toEqual(
      expected.map((chunk) => chunk.ordinal),
    );
    expect(stored.map((row) => row.contentHash)).toEqual(
      expected.map((chunk) => chunk.hash),
    );
    expect(stored.map((row) => row.text)).toEqual(
      expected.map((chunk) => chunk.text),
    );
    expect(stored.every((row) => row.model === "fake-embed")).toBe(true);
    expect(stored.every((row) => row.dimensions === 768)).toBe(true);
  });

  it("writes the vector, not just the text", async () => {
    await embedChapter(chapter());

    const plan = db.raw.sql`
      SELECT count(*)::int AS "missing"
        FROM "ai"."chapterChunk"
       WHERE "chapterId" = ${chapterId}
         AND "embedding" IS NULL
    `
      .returnsRow({ missing: "pg/int4@1" })
      .build();

    const [row] = (await db.runtime().query(plan)) as { missing: number }[];
    expect(row?.missing).toBe(0);
  });

  it("denormalises the story onto the row, so a search need not join", async () => {
    await embedChapter(chapter());

    const stored = await db.orm.ai.ChapterChunk.select("storyId")
      .where((row) => row.chapterId.eq(chapterId))
      .all();

    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every((row) => row.storyId === storyId)).toBe(true);
  });

  it("does nothing at all the second time", async () => {
    const first = await embedChapter(chapter());
    const before = await rows();

    embedder.reset();
    const second = await embedChapter(chapter());

    expect(embedder.calls).toHaveLength(0);
    expect(second.unchanged).toBe(true);
    expect(second.embedded).toBe(0);
    expect(second.tokensUsed).toBe(0);
    expect(second.reused).toBe(first.chunks);
    expect(await rows()).toEqual(before);
  });

  it("re-embeds only the windows an edit touched", async () => {
    await embedChapter(chapter());
    const before = await rows();

    // One word, in the last paragraph: every window before the ones that
    // paragraph falls in is unchanged and must keep the vector it has.
    const edited = ORIGINAL.replace(
      "Original paragraph 9.",
      "Rewritten paragraph 9.",
    );
    expect(edited).not.toBe(ORIGINAL);

    embedder.reset();
    const result = await embedChapter(chapter(edited));

    expect(result.unchanged).toBe(false);
    expect(result.reused).toBeGreaterThan(0);
    expect(result.embedded).toBeGreaterThan(0);
    expect(result.embedded).toBeLessThan(result.chunks);

    // Every text sent to the model is one of the windows that actually changed.
    const unchangedText = new Set(before.map((row) => row.text));
    for (const text of embeddedTexts()) {
      expect(unchangedText.has(text)).toBe(false);
    }
  });

  it("replaces the stored set rather than adding to it", async () => {
    await embedChapter(chapter());
    const shorter = chapterProse("Original", 3);

    const result = await embedChapter(chapter(shorter));
    const stored = await rows();

    expect(stored).toHaveLength(result.chunks);
    expect(stored.map((row) => row.contentHash)).toEqual(
      chunkChapter(shorter).map((chunk) => chunk.hash),
    );
  });

  it("re-embeds everything when the model changes under it", async () => {
    await embedChapter(chapter());

    // Same texts, a different embedder: vectors from two models are not
    // comparable, so nothing may be carried over however well the hashes match.
    const replacement = fakeAiEmbedder(768);
    Object.defineProperty(replacement, "model", { value: "other-embed" });
    setAiEmbedder(replacement);

    const result = await embedChapter(chapter());

    expect(result.unchanged).toBe(false);
    expect(result.reused).toBe(0);
    expect(result.embedded).toBe(result.chunks);
    expect((await rows()).every((row) => row.model === "other-embed")).toBe(
      true,
    );
  });

  it("rejects a width the column cannot hold, and stores nothing", async () => {
    embedder.returnWidthOnce(384);

    await expect(embedChapter(chapter())).rejects.toThrow(/384 dimensions/);
    expect(await rows()).toHaveLength(0);
  });

  it("leaves the previous rows intact when a re-embed fails", async () => {
    await embedChapter(chapter());
    const before = await rows();

    const edited = ORIGINAL.replace(
      "Original paragraph 0.",
      "Rewritten paragraph 0.",
    );
    embedder.returnWidthOnce(384);

    await expect(embedChapter(chapter(edited))).rejects.toThrow(/dimensions/);
    expect(await rows()).toEqual(before);
  });

  it("clears the rows for a chapter whose prose has gone", async () => {
    await embedChapter(chapter());

    const result = await embedChapter(chapter("   "));

    expect(result.chunks).toBe(0);
    expect(await rows()).toHaveLength(0);
  });

  it("loses its rows with the chapter, without anybody deleting them", async () => {
    // The foreign key cascades, unlike `ai.ChapterSummary` whose rows
    // `services/authoring.ts` deletes by hand. Nothing in the delete path
    // knows this table exists, and that is the property under test.
    const throwaway = await api.createChapter({
      storyId,
      number: 2,
      title: "To be deleted",
      content: ORIGINAL,
    });

    await embedChapter({ id: throwaway, storyId, content: ORIGINAL });

    const stored = await db.orm.ai.ChapterChunk.select("id")
      .where((row) => row.chapterId.eq(throwaway))
      .all();
    expect(stored.length).toBeGreaterThan(0);

    await db.orm.content.Chapter.where((row) => row.id.eq(throwaway)).delete();

    expect(
      await db.orm.ai.ChapterChunk.select("id")
        .where((row) => row.chapterId.eq(throwaway))
        .all(),
    ).toHaveLength(0);
  });
});
