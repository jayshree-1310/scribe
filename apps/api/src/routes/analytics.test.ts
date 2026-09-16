import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestApi, databaseAvailable } from "../test/harness.js";
import { flushAnalytics } from "../services/analytics.js";

const api = new TestApi();
const available = await databaseAvailable();

/**
 * One author per concern.
 *
 * The overview aggregates *every* story its caller has, so two suites sharing
 * an author would see each other's events in their totals. Splitting them is
 * cheaper than reasoning about which of the two wrote the row.
 */
let watched: string;
let ranger: string;
let quiet: string;
let stranger: string;

/** Readers, so "distinct visitors" is distinguishable from "events". */
let reader: string;
let second: string;

let story: { id: string; slug: string };
let chapterId: string;
let dated: { id: string; slug: string };
let empty: { id: string; slug: string };
let elsewhere: { id: string; slug: string };

beforeAll(async () => {
  if (!available) return;
  await api.start();

  watched = await api.createUser("anw", { isAuthor: true });
  ranger = await api.createUser("anr", { isAuthor: true });
  quiet = await api.createUser("anq", { isAuthor: true });
  stranger = await api.createUser("ans", { isAuthor: true });

  reader = await api.createUser("an1");
  second = await api.createUser("an2");

  story = await api.createStory({ title: "Watched Story", authorId: watched });
  chapterId = await api.createChapter({ storyId: story.id, number: 1 });
  await api.createChapter({ storyId: story.id, number: 2 });

  dated = await api.createStory({ title: "Dated Story", authorId: ranger });
  empty = await api.createStory({ title: "Unread Story", authorId: quiet });
  elsewhere = await api.createStory({ title: "Not Yours", authorId: stranger });
}, 30_000);

afterAll(async () => {
  if (available) await api.stop();
});

/**
 * The recording writes are fire-and-forget, so a response having arrived says
 * nothing about the row having landed. `flushAnalytics` is the seam the
 * service exposes for exactly this.
 */
async function read(path: string, as?: string): Promise<number> {
  const response = await api.request(path, as ? { as } : {});
  await flushAnalytics();
  return response.status;
}

describe.skipIf(!available)("recording story views", () => {
  it("records one view per reader per day, however many times they look", async () => {
    const before = await api.readViewCount(story.id);

    expect(await read(`/api/stories/${story.slug}`, reader)).toBe(200);
    expect(await read(`/api/stories/${story.slug}`, reader)).toBe(200);
    expect(await read(`/api/stories/${story.slug}`, reader)).toBe(200);

    expect(await api.countStoryViews(story.id)).toBe(1);
    // The lifetime counter moves with the log, not with the request count.
    expect(await api.readViewCount(story.id)).toBe(before + 1);
  });

  it("counts a second reader separately", async () => {
    expect(await read(`/api/stories/${story.slug}`, second)).toBe(200);

    expect(await api.countStoryViews(story.id)).toBe(2);
  });

  it("does not count the author looking at their own story", async () => {
    const before = await api.readViewCount(story.id);

    expect(await read(`/api/stories/${story.slug}`, watched)).toBe(200);

    expect(await api.countStoryViews(story.id)).toBe(2);
    expect(await api.readViewCount(story.id)).toBe(before);
  });

  it("records a chapter read once per reader per day", async () => {
    expect(await read(`/api/stories/${story.slug}/chapters/1`, reader)).toBe(200);
    expect(await read(`/api/stories/${story.slug}/chapters/1`, reader)).toBe(200);

    expect(await api.countChapterReads(chapterId)).toBe(1);
  });

  it("records nothing for a story the caller cannot see", async () => {
    const draft = await api.createStory({
      title: "Hidden Draft",
      authorId: watched,
      listed: false,
    });

    expect(await read(`/api/stories/${draft.slug}`, reader)).toBe(404);

    expect(await api.countStoryViews(draft.id)).toBe(0);
  });
});

describe.skipIf(!available)("GET /api/author/analytics", () => {
  it("refuses an anonymous caller", async () => {
    const response = await api.request("/api/author/analytics");

    expect(response.status).toBe(401);
  });

  it("rejects a range it does not offer", async () => {
    const response = await api.request("/api/author/analytics?range=all", {
      as: watched,
    });

    expect(response.status).toBe(400);
  });

  it("returns one point per day of the range, most recent last", async () => {
    for (const [range, days] of [
      ["7d", 7],
      ["30d", 30],
      ["90d", 90],
    ] as const) {
      const response = await api.request(
        `/api/author/analytics?range=${range}`,
        { as: watched },
      );

      expect(response.status).toBe(200);
      expect(response.body.range).toBe(range);
      expect(response.body.series).toHaveLength(days);
      expect(response.body.series[0].date).toBe(response.body.from);
      expect(response.body.series[days - 1].date).toBe(response.body.to);
    }
  });

  it("answers an author with no events at all in zeroes, not in gaps", async () => {
    const response = await api.request("/api/author/analytics?range=7d", {
      as: quiet,
    });

    expect(response.status).toBe(200);
    expect(response.body.totals).toEqual({
      views: 0,
      reads: 0,
      readers: 0,
      comments: 0,
      ratings: 0,
    });
    expect(response.body.series).toHaveLength(7);
    expect(
      response.body.series.every(
        (point: { views: number; reads: number }) =>
          point.views === 0 && point.reads === 0,
      ),
    ).toBe(true);

    // The story is still listed, with zeroes against it: an author whose work
    // nobody has opened has analytics, they are just all zero.
    expect(response.body.stories).toHaveLength(1);
    expect(response.body.stories[0]).toMatchObject({
      id: empty.id,
      views: 0,
      reads: 0,
      readers: 0,
    });
  });

  it("counts an event on the first day of the range and not the day before", async () => {
    // Six days ago is the `7d` window's first day; seven days ago is the day
    // before it, and inside `30d` either way.
    await api.recordEvent({ storyId: dated.id, userId: reader, daysAgo: 6 });
    await api.recordEvent({ storyId: dated.id, userId: second, daysAgo: 7 });

    const week = await api.request("/api/author/analytics?range=7d", {
      as: ranger,
    });
    const month = await api.request("/api/author/analytics?range=30d", {
      as: ranger,
    });

    expect(week.body.totals.views).toBe(1);
    expect(week.body.series[0]).toEqual({
      date: week.body.from,
      views: 1,
      reads: 0,
    });
    expect(month.body.totals.views).toBe(2);
  });

  it("counts a visitor once however many events they leave", async () => {
    const chapter = await api.createChapter({ storyId: dated.id, number: 1 });

    await api.recordEvent({ storyId: dated.id, chapterId: chapter, userId: reader });
    await api.recordEvent({ storyId: dated.id, userId: reader });

    const response = await api.request("/api/author/analytics?range=7d", {
      as: ranger,
    });

    // Three events inside the week -- two views and a read -- all one person.
    // The other reader's view sits a day outside it.
    expect(response.body.totals).toMatchObject({
      views: 2,
      reads: 1,
      readers: 1,
    });
  });

  it("swallows a second identical event rather than double-counting it", async () => {
    expect(
      await api.recordEvent({ storyId: dated.id, userId: reader }),
    ).toBe(false);
  });

  it("reports lifetime totals over the author's own Scribe stories", async () => {
    // A catalogue edition carries a real author column and nobody wrote it
    // here, so it must not appear in either the totals or the story list.
    await api.createBook({ title: "Imported Edition", authorId: quiet });

    const response = await api.request("/api/author/analytics", { as: quiet });

    expect(response.body.lifetime).toMatchObject({
      stories: 1,
      published: 1,
      ratings: 0,
      ratingAverage: null,
    });
    expect(response.body.stories).toHaveLength(1);
    expect(response.body.stories[0].id).toBe(empty.id);
  });

  it("shows an author their own drafts", async () => {
    const response = await api.request("/api/author/analytics", { as: watched });
    const statuses = response.body.stories.map(
      (row: { status: string }) => row.status,
    );

    expect(statuses).toContain("draft");
  });

  it("never shows one author another's stories", async () => {
    const response = await api.request("/api/author/analytics", { as: watched });
    const ids = response.body.stories.map((row: { id: string }) => row.id);

    expect(ids).not.toContain(elsewhere.id);
  });
});

describe.skipIf(!available)("GET /api/author/analytics/stories/:id", () => {
  it("breaks a story down by chapter", async () => {
    const response = await api.request(
      `/api/author/analytics/stories/${story.id}?range=7d`,
      { as: watched },
    );

    expect(response.status).toBe(200);
    expect(response.body.story.id).toBe(story.id);
    expect(response.body.series).toHaveLength(7);

    const chapters = response.body.chapters;
    expect(chapters).toHaveLength(2);
    // In reading order, whatever order the reads arrived in.
    expect(chapters.map((row: { number: number }) => row.number)).toEqual([1, 2]);
    expect(chapters[0]).toMatchObject({ id: chapterId, reads: 1, readers: 1 });
    expect(chapters[1]).toMatchObject({ reads: 0, readers: 0 });
  });

  it("refuses a story that is not the caller's", async () => {
    const response = await api.request(
      `/api/author/analytics/stories/${elsewhere.id}`,
      { as: watched },
    );

    expect(response.status).toBe(404);
  });

  it("rejects an id that is not one", async () => {
    const response = await api.request("/api/author/analytics/stories/nope", {
      as: watched,
    });

    expect(response.status).toBe(400);
  });
});
