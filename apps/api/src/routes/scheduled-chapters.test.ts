import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Temporal } from "temporal-polyfill";
import { TestApi, databaseAvailable } from "../test/harness.js";
import { flushBadges } from "../services/gamification.js";
import { flushNotifications } from "../services/notifications.js";
import { releaseDueChapters, type AuthoredChapter } from "../services/authoring.js";
import type { StoryDetail } from "../services/stories.js";

const api = new TestApi();
const available = await databaseAvailable();

let author: string;
let reader: string;
let stranger: string;

beforeAll(async () => {
  if (!available) return;
  await api.start();

  author = await api.createUser("schauth", { isAuthor: true });
  reader = await api.createUser("schread");
  stranger = await api.createUser("schstra");
}, 30_000);

afterAll(async () => {
  if (available) await api.stop();
});

/** Badge awards notify too, so they settle first; see `notifications.test.ts`. */
async function settle(): Promise<void> {
  await flushBadges();
  await flushNotifications();
}

/**
 * A running dev server ticks `releaseDueChapters` against the same database,
 * so a due chapter may be released by that process instead of this one. Each
 * release is claimed exactly once either way; this waits for the outcome
 * rather than assuming which process produced it.
 */
async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 30 && !done(value); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    value = await read();
  }
  return value;
}

function inMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

async function schedule(as: string, chapterId: string, at: string) {
  return api.request<{ chapter: AuthoredChapter }>(
    `/api/author/chapters/${chapterId}/schedule`,
    { method: "PUT", as, body: { at } },
  );
}

async function chapterRow(chapterId: string) {
  const { db } = await import("../prisma/db.js");
  const row = await db.orm.content.Chapter.select("publishedAt", "scheduledAt")
    .where((chapter) => chapter.id.eq(chapterId))
    .first();
  return {
    publishedAt: row?.publishedAt ? String(row.publishedAt) : null,
    scheduledAt: row?.scheduledAt ? String(row.scheduledAt) : null,
  };
}

/** Moves a schedule into the past, which the API itself refuses to set. */
async function makeDue(chapterId: string): Promise<string> {
  const { db } = await import("../prisma/db.js");
  const at = Temporal.Now.instant().subtract({ seconds: 5 });
  await db.orm.content.Chapter.where((chapter) => chapter.id.eq(chapterId)).update({
    scheduledAt: at,
  });
  return String(at);
}

async function newChapterNotices(userId: string, chapterId: string): Promise<number> {
  const { db } = await import("../prisma/db.js");
  const rows = await db.orm.notifications.Notification.select("id")
    .where((row) => row.userId.eq(userId))
    .where((row) => row.type.eq("NEW_CHAPTER"))
    .where((row) => row.sourceId.eq(chapterId))
    .all();
  return rows.length;
}

async function shelve(userId: string, storyId: string): Promise<void> {
  const { db } = await import("../prisma/db.js");
  await db.orm.library.LibraryEntry.create({ userId, storyId, status: "READING" });
}

describe.skipIf(!available)("scheduling a chapter", () => {
  it("sets a time, shows readers when it arrives, and keeps the chapter hidden until then", async () => {
    const story = await api.createStory({ title: "Scheduled Story", authorId: author });
    await api.createChapter({ storyId: story.id, number: 1 });
    const two = await api.createChapter({ storyId: story.id, number: 2, published: false });

    const at = inMinutes(90);
    const set = await schedule(author, two, at);
    expect(set.status).toBe(200);
    expect(set.body.chapter.scheduledAt).toBe(at);
    expect(set.body.chapter.publishedAt).toBeNull();

    const page = await api.request<{ story: StoryDetail }>(`/api/stories/${story.slug}`, {
      as: reader,
    });
    expect(page.body.story.nextRelease).toEqual({ number: 2, scheduledAt: at });

    // The author's own chapter list carries the time on the draft's row;
    // a reader's list has no such row at all.
    type Row = { number: number; scheduledAt: string | null };
    const mine = await api.request<{ chapters: Row[] }>(`/api/stories/${story.slug}/chapters`, {
      as: author,
    });
    expect(mine.body.chapters.find((row) => row.number === 2)?.scheduledAt).toBe(at);
    const theirs = await api.request<{ chapters: Row[] }>(`/api/stories/${story.slug}/chapters`, {
      as: reader,
    });
    expect(theirs.body.chapters.map((row) => row.number)).toEqual([1]);

    // Coming, not here: the chapter itself is still a draft to readers.
    expect(
      (await api.request(`/api/stories/${story.slug}/chapters/2`, { as: reader })).status,
    ).toBe(404);

    const cleared = await api.request<{ chapter: AuthoredChapter }>(
      `/api/author/chapters/${two}/schedule`,
      { method: "DELETE", as: author },
    );
    expect(cleared.status).toBe(200);
    expect(cleared.body.chapter.scheduledAt).toBeNull();

    const after = await api.request<{ story: StoryDetail }>(`/api/stories/${story.slug}`);
    expect(after.body.story.nextRelease).toBeNull();
  });

  it("refuses a time too soon or too far, an empty or published chapter, and anybody else's", async () => {
    const story = await api.createStory({ title: "Refused Schedules", authorId: author });
    const live = await api.createChapter({ storyId: story.id, number: 1 });
    const empty = await api.createChapter({
      storyId: story.id,
      number: 2,
      content: "   ",
      published: false,
    });
    const draft = await api.createChapter({ storyId: story.id, number: 3, published: false });

    expect((await schedule(author, draft, inMinutes(-5))).status).toBe(400);
    expect((await schedule(author, draft, inMinutes(60 * 24 * 400))).status).toBe(400);
    expect((await schedule(author, draft, "next tuesday")).status).toBe(400);
    expect((await schedule(author, empty, inMinutes(60))).status).toBe(400);
    expect((await schedule(author, live, inMinutes(60))).status).toBe(409);
    expect([403, 404]).toContain((await schedule(stranger, draft, inMinutes(60))).status);
  });

  it("is overtaken by publishing by hand", async () => {
    const story = await api.createStory({ title: "Published Early", authorId: author });
    const draft = await api.createChapter({ storyId: story.id, number: 1, published: false });
    await schedule(author, draft, inMinutes(60));

    const published = await api.request<{ chapter: AuthoredChapter }>(
      `/api/author/chapters/${draft}/publish`,
      { method: "POST", as: author },
    );
    expect(published.status).toBe(200);
    expect(published.body.chapter.publishedAt).not.toBeNull();
    expect(published.body.chapter.scheduledAt).toBeNull();
  });
});

describe.skipIf(!available)("releasing scheduled chapters", () => {
  it("publishes at the scheduled time, once, and tells the story's readers but not its author", async () => {
    const story = await api.createStory({ title: "Released Story", authorId: author });
    await api.createChapter({ storyId: story.id, number: 1 });
    const two = await api.createChapter({ storyId: story.id, number: 2, published: false });
    await shelve(reader, story.id);
    await shelve(author, story.id);

    await schedule(author, two, inMinutes(60));
    const dueAt = await makeDue(two);

    await releaseDueChapters();
    await settle();

    const row = await eventually(() => chapterRow(two), (value) => value.publishedAt !== null);
    expect(row).toEqual({ publishedAt: dueAt, scheduledAt: null });

    expect(await eventually(() => newChapterNotices(reader, two), (n) => n > 0)).toBe(1);
    expect(await newChapterNotices(author, two)).toBe(0);
    expect(await newChapterNotices(stranger, two)).toBe(0);

    // A second tick finds nothing to do: no republish, no second notice.
    await releaseDueChapters();
    await settle();
    expect(await newChapterNotices(reader, two)).toBe(1);

    const readable = await api.request(`/api/stories/${story.slug}/chapters/2`, { as: reader });
    expect(readable.status).toBe(200);
  });

  it("drops the schedule instead of publishing for an author suspended since", async () => {
    const story = await api.createStory({ title: "Suspended Release", authorId: stranger });
    await api.createChapter({ storyId: story.id, number: 1 });
    const two = await api.createChapter({ storyId: story.id, number: 2, published: false });

    await schedule(stranger, two, inMinutes(60));
    await makeDue(two);
    await api.setSuspended(stranger);

    try {
      await releaseDueChapters();
      const row = await eventually(() => chapterRow(two), (value) => value.scheduledAt === null);
      expect(row).toEqual({ publishedAt: null, scheduledAt: null });
    } finally {
      await api.setSuspended(stranger, false);
    }
  });
});
