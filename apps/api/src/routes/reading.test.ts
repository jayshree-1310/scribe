import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestApi, databaseAvailable } from "../test/harness.js";

const api = new TestApi();
const available = await databaseAvailable();

let author: string;
let reader: string;
let otherReader: string;

/** A three-chapter story with deliberately uneven chapter lengths. */
let storyId: string;
let chapterOne: string;
let chapterTwo: string;
let chapterThree: string;

/** A second story, so the continue list has something to order. */
let otherStoryId: string;
let otherChapter: string;

/** A draft with one unpublished chapter, visible only to its author. */
let draftId: string;
let draftChapter: string;

/** The text every fixture chapter carries, so offsets are predictable. */
const BODY = "x".repeat(100);

function save(
  body: Record<string, unknown>,
  as: string | undefined = reader,
) {
  return api.request("/api/reading/progress", { method: "PUT", as, body });
}

beforeAll(async () => {
  if (!available) return;
  await api.start();

  author = await api.createUser("author");
  reader = await api.createUser("reader");
  otherReader = await api.createUser("nosy");

  const genreId = await api.createGenre("Progress");

  const story = await api.createStory({
    title: "The Long Way Round",
    authorId: author,
    genreIds: [genreId],
  });
  storyId = story.id;

  // 100, 300 and 100 words: a position in chapter two has to be weighted by
  // its length, not by "chapter 2 of 3".
  chapterOne = await api.createChapter({
    storyId,
    number: 1,
    content: BODY,
    wordCount: 100,
  });
  chapterTwo = await api.createChapter({
    storyId,
    number: 2,
    content: BODY,
    wordCount: 300,
  });
  chapterThree = await api.createChapter({
    storyId,
    number: 3,
    content: BODY,
    wordCount: 100,
  });

  const other = await api.createStory({
    title: "A Shorter Trip",
    authorId: author,
    genreIds: [genreId],
  });
  otherStoryId = other.id;
  otherChapter = await api.createChapter({
    storyId: otherStoryId,
    number: 1,
    content: BODY,
    wordCount: 50,
  });

  const draft = await api.createStory({
    title: "Not Ready Yet",
    authorId: author,
    listed: false,
  });
  draftId = draft.id;
  draftChapter = await api.createChapter({
    storyId: draftId,
    number: 1,
    content: BODY,
    published: false,
  });
}, 30_000);

afterAll(async () => {
  if (available) await api.stop();
});

/** Leaves every reader without a saved position, so suites do not leak state. */
async function clearAll(): Promise<void> {
  for (const as of [reader, otherReader, author]) {
    for (const id of [storyId, otherStoryId, draftId]) {
      await api.request(`/api/reading/progress/${id}`, { method: "DELETE", as });
    }
  }
}

describe.skipIf(!available)("authorisation", () => {
  it("401s on every reading route without a reader", async () => {
    const responses = await Promise.all([
      api.request("/api/reading/continue"),
      api.request("/api/reading/progress", {
        method: "PUT",
        body: { storyId, chapterId: chapterOne, offset: 0 },
      }),
      api.request(`/api/reading/progress/${storyId}`),
      api.request(`/api/reading/progress/${storyId}`, { method: "DELETE" }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("unauthorized");
    }
  });

  it("never shows one reader another reader's position", async () => {
    await save({ storyId, chapterId: chapterOne, offset: 50 });

    const mine = await api.request(`/api/reading/progress/${storyId}`, {
      as: reader,
    });
    const theirs = await api.request(`/api/reading/progress/${storyId}`, {
      as: otherReader,
    });

    expect(mine.body.progress.offset).toBe(50);
    expect(theirs.body.progress).toBeNull();

    const theirList = await api.request("/api/reading/continue", {
      as: otherReader,
    });
    expect(theirList.body.entries).toHaveLength(0);

    await clearAll();
  });

  it("404s on a draft the caller did not write", async () => {
    const blocked = await save(
      { storyId: draftId, chapterId: draftChapter, offset: 10 },
      otherReader,
    );

    expect(blocked.status).toBe(404);
    expect(blocked.body.error.code).toBe("not_found");
  });

  it("lets an author record a position in their own draft", async () => {
    const saved = await save(
      { storyId: draftId, chapterId: draftChapter, offset: 10 },
      author,
    );

    expect(saved.status).toBe(200);
    expect(saved.body.progress.chapterNumber).toBe(1);

    await clearAll();
  });
});

describe.skipIf(!available)("PUT /progress", () => {
  it("is idempotent: repeated saves update one row rather than adding rows", async () => {
    const first = await save({ storyId, chapterId: chapterOne, offset: 10 });
    const second = await save({ storyId, chapterId: chapterOne, offset: 60 });
    const third = await save({ storyId, chapterId: chapterTwo, offset: 20 });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);

    // One row per story is the table's own unique pair; the continue list is
    // where a duplicate would show up.
    const list = await api.request("/api/reading/continue", { as: reader });
    const forStory = list.body.entries.filter(
      (entry: { story: { id: string } }) => entry.story.id === storyId,
    );

    expect(forStory).toHaveLength(1);
    expect(forStory[0].progress.chapterId).toBe(chapterTwo);
    expect(forStory[0].progress.offset).toBe(20);

    await clearAll();
  });

  it("concurrent saves of the same story still leave one row", async () => {
    const responses = await Promise.all([
      save({ storyId, chapterId: chapterOne, offset: 5 }),
      save({ storyId, chapterId: chapterOne, offset: 15 }),
      save({ storyId, chapterId: chapterOne, offset: 25 }),
    ]);

    for (const response of responses) expect(response.status).toBe(200);

    const list = await api.request("/api/reading/continue", { as: reader });
    expect(
      list.body.entries.filter(
        (entry: { story: { id: string } }) => entry.story.id === storyId,
      ),
    ).toHaveLength(1);

    await clearAll();
  });

  it("weights percent complete by word count, not by chapter number", async () => {
    // Start of chapter two: chapter one's 100 of the story's 500 words.
    const atStart = await save({ storyId, chapterId: chapterTwo, offset: 0 });
    expect(atStart.body.progress.percentComplete).toBe(20);

    // Half way through chapter two: 100 + 150 of 500.
    const halfWay = await save({ storyId, chapterId: chapterTwo, offset: 50 });
    expect(halfWay.body.progress.percentComplete).toBe(50);

    // End of the last chapter.
    const atEnd = await save({
      storyId,
      chapterId: chapterThree,
      offset: BODY.length,
    });
    expect(atEnd.body.progress.percentComplete).toBe(100);

    await clearAll();
  });

  it("clamps an offset past the end of the chapter", async () => {
    const saved = await save({
      storyId,
      chapterId: chapterOne,
      offset: 10_000,
    });

    expect(saved.status).toBe(200);
    expect(saved.body.progress.offset).toBe(BODY.length);

    await clearAll();
  });

  it("rejects a chapter that belongs to another story", async () => {
    const mismatched = await save({
      storyId,
      chapterId: otherChapter,
      offset: 0,
    });

    expect(mismatched.status).toBe(404);
    expect(mismatched.body.error.code).toBe("not_found");
  });

  it("rejects a negative offset and a malformed story id", async () => {
    const negative = await save({
      storyId,
      chapterId: chapterOne,
      offset: -1,
    });
    const malformed = await save({
      storyId: "not-a-uuid",
      chapterId: chapterOne,
      offset: 0,
    });

    expect(negative.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.details.storyId).toBeDefined();
  });
});

describe.skipIf(!available)("GET /continue", () => {
  it("returns most recently read first, one row per story", async () => {
    await save({ storyId, chapterId: chapterOne, offset: 10 });
    await save({ storyId: otherStoryId, chapterId: otherChapter, offset: 10 });
    // Back to the first story, which must move it to the front.
    await save({ storyId, chapterId: chapterTwo, offset: 30 });

    const list = await api.request("/api/reading/continue", { as: reader });

    expect(list.status).toBe(200);
    expect(
      list.body.entries.map((entry: { story: { id: string } }) => entry.story.id),
    ).toEqual([storyId, otherStoryId]);

    const [first] = list.body.entries;
    expect(first.chapter).toEqual({
      id: chapterTwo,
      number: 2,
      title: "Chapter 2",
    });
    expect(first.story.title).toBe("The Long Way Round");
    expect(first.progress.lastReadAt).toEqual(expect.any(String));

    await clearAll();
  });

  it("honours limit, and rejects one outside the range", async () => {
    await save({ storyId, chapterId: chapterOne, offset: 10 });
    await save({ storyId: otherStoryId, chapterId: otherChapter, offset: 10 });

    const limited = await api.request("/api/reading/continue?limit=1", {
      as: reader,
    });
    expect(limited.body.entries).toHaveLength(1);
    expect(limited.body.entries[0].story.id).toBe(otherStoryId);

    const tooMany = await api.request("/api/reading/continue?limit=999", {
      as: reader,
    });
    expect(tooMany.status).toBe(400);

    await clearAll();
  });

  it("is empty, not an error, for a reader who has read nothing", async () => {
    const list = await api.request("/api/reading/continue", {
      as: otherReader,
    });

    expect(list.status).toBe(200);
    expect(list.body.entries).toEqual([]);
  });
});

describe.skipIf(!available)("GET and DELETE /progress/:storyId", () => {
  it("answers null for a story with no saved position", async () => {
    const response = await api.request(`/api/reading/progress/${storyId}`, {
      as: reader,
    });

    expect(response.status).toBe(200);
    expect(response.body.progress).toBeNull();
  });

  it("round-trips the resume point", async () => {
    await save({ storyId, chapterId: chapterTwo, offset: 25 });

    const response = await api.request(`/api/reading/progress/${storyId}`, {
      as: reader,
    });

    expect(response.body.progress).toMatchObject({
      storyId,
      chapterId: chapterTwo,
      chapterNumber: 2,
      offset: 25,
      percentComplete: 35,
    });

    await clearAll();
  });

  it("clears a position, and 404s on clearing one that is not there", async () => {
    await save({ storyId, chapterId: chapterOne, offset: 5 });

    const cleared = await api.request(`/api/reading/progress/${storyId}`, {
      method: "DELETE",
      as: reader,
    });
    expect(cleared.status).toBe(204);

    const after = await api.request(`/api/reading/progress/${storyId}`, {
      as: reader,
    });
    expect(after.body.progress).toBeNull();

    const again = await api.request(`/api/reading/progress/${storyId}`, {
      method: "DELETE",
      as: reader,
    });
    expect(again.status).toBe(404);
  });
});

describe.skipIf(!available)("reading streak", () => {
  it("starts a streak at 1 on a reader's first recorded progress", async () => {
    await api.setStreak(reader, { streak: 0, lastReadAt: null });

    const saved = await save({ storyId, chapterId: chapterOne, offset: 10 });

    expect(saved.body.readingStreak).toBe(1);
    expect((await api.readStreak(reader)).streak).toBe(1);

    await clearAll();
  });

  it("does not move on a second save the same day", async () => {
    await api.setStreak(reader, { streak: 0, lastReadAt: null });

    await save({ storyId, chapterId: chapterOne, offset: 10 });
    const anchor = (await api.readStreak(reader)).lastReadAt;

    const again = await save({ storyId, chapterId: chapterOne, offset: 20 });

    expect(again.body.readingStreak).toBe(1);

    const after = await api.readStreak(reader);
    expect(after.streak).toBe(1);
    // The anchor is left alone too, not rewritten to the later instant.
    expect(after.lastReadAt?.toISOString()).toBe(anchor?.toISOString());

    await clearAll();
  });

  it("increments when the last read was yesterday", async () => {
    await api.setStreak(reader, {
      streak: 4,
      lastReadAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    const saved = await save({ storyId, chapterId: chapterOne, offset: 10 });

    expect(saved.body.readingStreak).toBe(5);
    expect((await api.readStreak(reader)).streak).toBe(5);

    await clearAll();
  });

  it("resets after a missed day", async () => {
    await api.setStreak(reader, {
      streak: 11,
      lastReadAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    });

    const saved = await save({ storyId, chapterId: chapterOne, offset: 10 });

    expect(saved.body.readingStreak).toBe(1);
    expect((await api.readStreak(reader)).streak).toBe(1);

    await clearAll();
  });
});
