import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestApi, databaseAvailable } from "../test/harness.js";

const api = new TestApi();
const available = await databaseAvailable();

/** The author of every fixture story below. */
let author: string;
/** Two signed-in readers, so "somebody else's comment" is expressible. */
let reader: string;
let other: string;

let storyId: string;
let storySlug: string;
let chapterId: string;

/** A draft only its author can see, for the visibility rule. */
let draftId: string;
let draftSlug: string;

beforeAll(async () => {
  if (!available) return;
  await api.start();

  author = await api.createUser("ea");
  reader = await api.createUser("er");
  other = await api.createUser("eo");

  const story = await api.createStory({
    title: "The Cartographer's Apprentice",
    authorId: author,
  });
  storyId = story.id;
  storySlug = story.slug;
  chapterId = await api.createChapter({ storyId, number: 1 });

  const draft = await api.createStory({
    title: "Notes Toward a Second Volume",
    authorId: author,
    listed: false,
  });
  draftId = draft.id;
  draftSlug = draft.slug;
}, 30_000);

afterAll(async () => {
  if (available) await api.stop();
});

/* Comments --------------------------------------------------------------- */

describe.skipIf(!available)("reading comments", () => {
  it("lists a story's comments publicly, newest first, with an author summary", async () => {
    const story = await api.createStory({ title: "Listing", authorId: author });

    await api.createComment({
      storyId: story.id,
      userId: reader,
      content: "First.",
    });
    await api.createComment({
      storyId: story.id,
      userId: other,
      content: "Second.",
    });

    const { status, body } = await api.request(
      `/api/stories/${story.slug}/comments`,
    );

    expect(status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.items.map((item: { content: string }) => item.content)).toEqual([
      "Second.",
      "First.",
    ]);

    // Exactly the four-field author summary -- never the whole user row.
    expect(Object.keys(body.items[0].user).sort()).toEqual([
      "avatarUrl",
      "displayName",
      "id",
      "username",
    ]);
  });

  it("lists threads only, with a reply count, and replies on request", async () => {
    const story = await api.createStory({ title: "Threading", authorId: author });

    const thread = await api.createComment({
      storyId: story.id,
      userId: reader,
      content: "A thought.",
    });
    await api.createComment({
      storyId: story.id,
      userId: other,
      content: "Agreed.",
      parentId: thread,
    });

    const threads = await api.request(`/api/stories/${story.id}/comments`);

    expect(threads.body.total).toBe(1);
    expect(threads.body.items[0].id).toBe(thread);
    expect(threads.body.items[0].replyCount).toBe(1);

    const replies = await api.request(
      `/api/stories/${story.id}/comments?parentId=${thread}`,
    );

    expect(replies.body.total).toBe(1);
    expect(replies.body.items[0].content).toBe("Agreed.");
    expect(replies.body.items[0].parentId).toBe(thread);
  });

  it("narrows to one chapter when asked", async () => {
    const story = await api.createStory({ title: "Scoped", authorId: author });
    const first = await api.createChapter({ storyId: story.id, number: 1 });

    await api.createComment({
      storyId: story.id,
      userId: reader,
      content: "On chapter one.",
      chapterId: first,
    });
    await api.createComment({
      storyId: story.id,
      userId: reader,
      content: "On the story.",
    });

    const scoped = await api.request(
      `/api/stories/${story.id}/comments?chapterId=${first}`,
    );

    expect(scoped.body.total).toBe(1);
    expect(scoped.body.items[0].content).toBe("On chapter one.");

    const all = await api.request(`/api/stories/${story.id}/comments`);
    expect(all.body.total).toBe(2);
  });

  it("hides a draft's comments from everyone but its author", async () => {
    await api.createComment({
      storyId: draftId,
      userId: author,
      content: "A note to myself.",
    });

    const stranger = await api.request(`/api/stories/${draftSlug}/comments`);
    expect(stranger.status).toBe(404);

    const owner = await api.request(`/api/stories/${draftSlug}/comments`, {
      as: author,
    });
    expect(owner.status).toBe(200);
    expect(owner.body.total).toBe(1);
  });
});

describe.skipIf(!available)("posting comments", () => {
  it("rejects an anonymous post", async () => {
    const { status } = await api.request(
      `/api/stories/${storySlug}/comments`,
      { method: "POST", body: { content: "Hello." } },
    );

    expect(status).toBe(401);
  });

  it("stores a trimmed body and returns it with its author", async () => {
    const { status, body } = await api.request(
      `/api/stories/${storySlug}/comments`,
      { method: "POST", as: reader, body: { content: "  Loved this.  " } },
    );

    expect(status).toBe(201);
    expect(body.comment.content).toBe("Loved this.");
    expect(body.comment.user.id).toBe(reader);
    expect(body.comment.parentId).toBeNull();
    expect(body.comment.chapterId).toBeNull();
  });

  it("rejects a body that is empty once trimmed", async () => {
    const { status, body } = await api.request(
      `/api/stories/${storySlug}/comments`,
      { method: "POST", as: reader, body: { content: "   \n\t  " } },
    );

    expect(status).toBe(400);
    expect(body.error.details.content).toBeDefined();
  });

  it("rejects a body over 2000 characters", async () => {
    const { status } = await api.request(
      `/api/stories/${storySlug}/comments`,
      { method: "POST", as: reader, body: { content: "x".repeat(2001) } },
    );

    expect(status).toBe(400);
  });

  it("accepts a body of exactly 2000 characters", async () => {
    const { status } = await api.request(
      `/api/stories/${storySlug}/comments`,
      { method: "POST", as: reader, body: { content: "x".repeat(2000) } },
    );

    expect(status).toBe(201);
  });

  it("attaches a comment to a chapter of the same story", async () => {
    const { status, body } = await api.request(
      `/api/stories/${storySlug}/comments`,
      {
        method: "POST",
        as: reader,
        body: { content: "That ending!", chapterId },
      },
    );

    expect(status).toBe(201);
    expect(body.comment.chapterId).toBe(chapterId);
  });

  it("rejects a chapter belonging to another story", async () => {
    const elsewhere = await api.createStory({
      title: "Somewhere Else",
      authorId: author,
    });
    const foreign = await api.createChapter({
      storyId: elsewhere.id,
      number: 1,
    });

    const { status } = await api.request(
      `/api/stories/${storySlug}/comments`,
      {
        method: "POST",
        as: reader,
        body: { content: "Wrong story.", chapterId: foreign },
      },
    );

    expect(status).toBe(404);
  });

  it("caps replies at one level, re-pointing a reply to a reply at its thread", async () => {
    const story = await api.createStory({ title: "Depth", authorId: author });

    const thread = await api.request(`/api/stories/${story.id}/comments`, {
      method: "POST",
      as: reader,
      body: { content: "The thread." },
    });

    const reply = await api.request(`/api/stories/${story.id}/comments`, {
      method: "POST",
      as: other,
      body: { content: "A reply.", parentId: thread.body.comment.id },
    });

    expect(reply.body.comment.parentId).toBe(thread.body.comment.id);

    // Replying to the reply attaches to the thread, not to the reply.
    const nested = await api.request(`/api/stories/${story.id}/comments`, {
      method: "POST",
      as: reader,
      body: { content: "A reply to the reply.", parentId: reply.body.comment.id },
    });

    expect(nested.body.comment.parentId).toBe(thread.body.comment.id);
  });

  it("gives a reply its thread's chapter rather than the caller's", async () => {
    const story = await api.createStory({ title: "Inherit", authorId: author });
    const one = await api.createChapter({ storyId: story.id, number: 1 });
    const two = await api.createChapter({ storyId: story.id, number: 2 });

    const thread = await api.request(`/api/stories/${story.id}/comments`, {
      method: "POST",
      as: reader,
      body: { content: "On chapter one.", chapterId: one },
    });

    const reply = await api.request(`/api/stories/${story.id}/comments`, {
      method: "POST",
      as: other,
      body: {
        content: "Replying, but claiming chapter two.",
        parentId: thread.body.comment.id,
        chapterId: two,
      },
    });

    expect(reply.body.comment.chapterId).toBe(one);
  });

  it("rejects a parent from another story", async () => {
    const elsewhere = await api.createStory({
      title: "Another Story Entirely",
      authorId: author,
    });
    const foreign = await api.createComment({
      storyId: elsewhere.id,
      userId: reader,
    });

    const { status } = await api.request(
      `/api/stories/${storySlug}/comments`,
      {
        method: "POST",
        as: reader,
        body: { content: "Wrong thread.", parentId: foreign },
      },
    );

    expect(status).toBe(404);
  });

  it("refuses to comment on a draft the caller cannot see", async () => {
    const { status } = await api.request(`/api/stories/${draftSlug}/comments`, {
      method: "POST",
      as: reader,
      body: { content: "How did I get here?" },
    });

    expect(status).toBe(404);
  });
});

describe.skipIf(!available)("deleting comments", () => {
  it("lets the author delete their own comment", async () => {
    const story = await api.createStory({ title: "Mine", authorId: author });
    const comment = await api.createComment({
      storyId: story.id,
      userId: reader,
    });

    const { status } = await api.request(`/api/comments/${comment}`, {
      method: "DELETE",
      as: reader,
    });

    expect(status).toBe(204);

    const list = await api.request(`/api/stories/${story.id}/comments`);
    expect(list.body.total).toBe(0);
  });

  it("refuses somebody else's comment with a 403", async () => {
    const story = await api.createStory({ title: "Not Mine", authorId: author });
    const comment = await api.createComment({
      storyId: story.id,
      userId: reader,
    });

    const { status } = await api.request(`/api/comments/${comment}`, {
      method: "DELETE",
      as: other,
    });

    expect(status).toBe(403);

    const list = await api.request(`/api/stories/${story.id}/comments`);
    expect(list.body.total).toBe(1);
  });

  it("refuses the story's author too -- moderation is Task 15's decision", async () => {
    const story = await api.createStory({ title: "Not Yours", authorId: author });
    const comment = await api.createComment({
      storyId: story.id,
      userId: reader,
    });

    const { status } = await api.request(`/api/comments/${comment}`, {
      method: "DELETE",
      as: author,
    });

    expect(status).toBe(403);
  });

  it("takes a thread's replies with it", async () => {
    const story = await api.createStory({ title: "Cascade", authorId: author });

    const thread = await api.createComment({
      storyId: story.id,
      userId: reader,
    });
    await api.createComment({
      storyId: story.id,
      userId: other,
      parentId: thread,
    });
    await api.createComment({
      storyId: story.id,
      userId: other,
      parentId: thread,
    });

    const { status } = await api.request(`/api/comments/${thread}`, {
      method: "DELETE",
      as: reader,
    });

    expect(status).toBe(204);

    const replies = await api.request(
      `/api/stories/${story.id}/comments?parentId=${thread}`,
    );
    expect(replies.body.total).toBe(0);
  });

  it("answers 404 for a comment that does not exist", async () => {
    const { status } = await api.request(
      "/api/comments/00000000-0000-4000-8000-000000000999",
      { method: "DELETE", as: reader },
    );

    expect(status).toBe(404);
  });
});

/* Ratings ---------------------------------------------------------------- */

describe.skipIf(!available)("ratings", () => {
  it("returns a full breakdown and a null average for an unrated story", async () => {
    const story = await api.createStory({ title: "Unrated", authorId: author });

    const { status, body } = await api.request(
      `/api/stories/${story.slug}/ratings`,
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({
      average: null,
      count: 0,
      mine: null,
      // Every key present, even at zero, so the bars have five rows to draw.
      breakdown: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    });
  });

  it("computes average, count and breakdown from real rows", async () => {
    const story = await api.createStory({ title: "Counted", authorId: author });

    await api.createRating({ storyId: story.id, userId: reader, rating: 5 });
    await api.createRating({ storyId: story.id, userId: other, rating: 3 });
    await api.createRating({ storyId: story.id, userId: author, rating: 4 });

    const { body } = await api.request(`/api/stories/${story.id}/ratings`);

    expect(body.count).toBe(3);
    expect(body.average).toBeCloseTo(4, 5);
    expect(body.breakdown).toEqual({ 1: 0, 2: 0, 3: 1, 4: 1, 5: 1 });
  });

  it("reports the caller's own score and nobody else's", async () => {
    const story = await api.createStory({ title: "Mine Only", authorId: author });

    await api.createRating({ storyId: story.id, userId: reader, rating: 2 });

    const asReader = await api.request(`/api/stories/${story.id}/ratings`, {
      as: reader,
    });
    expect(asReader.body.mine).toBe(2);

    const asOther = await api.request(`/api/stories/${story.id}/ratings`, {
      as: other,
    });
    expect(asOther.body.mine).toBeNull();

    const anonymous = await api.request(`/api/stories/${story.id}/ratings`);
    expect(anonymous.body.mine).toBeNull();
  });

  it("upserts: rating twice replaces rather than duplicates", async () => {
    const story = await api.createStory({ title: "Replaced", authorId: author });

    const first = await api.request(`/api/stories/${story.slug}/rating`, {
      method: "PUT",
      as: reader,
      body: { rating: 2 },
    });

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ count: 1, average: 2, mine: 2 });

    const second = await api.request(`/api/stories/${story.slug}/rating`, {
      method: "PUT",
      as: reader,
      body: { rating: 5 },
    });

    expect(second.body).toMatchObject({ count: 1, average: 5, mine: 5 });
    expect(second.body.breakdown).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 });
  });

  it("rejects a score outside 1-5, and a fractional one", async () => {
    for (const rating of [0, 6, -1, 3.5]) {
      const { status } = await api.request(`/api/stories/${storySlug}/rating`, {
        method: "PUT",
        as: reader,
        body: { rating },
      });

      expect(status, `rating ${rating}`).toBe(400);
    }
  });

  it("rejects an anonymous rating", async () => {
    const { status } = await api.request(`/api/stories/${storySlug}/rating`, {
      method: "PUT",
      body: { rating: 4 },
    });

    expect(status).toBe(401);
  });

  it("removes a rating, and is silent when there was none", async () => {
    const story = await api.createStory({ title: "Withdrawn", authorId: author });

    await api.request(`/api/stories/${story.id}/rating`, {
      method: "PUT",
      as: reader,
      body: { rating: 4 },
    });

    const removed = await api.request(`/api/stories/${story.id}/rating`, {
      method: "DELETE",
      as: reader,
    });

    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ count: 0, average: null, mine: null });

    // Removing again is not an error: the caller has no rating either way.
    const again = await api.request(`/api/stories/${story.id}/rating`, {
      method: "DELETE",
      as: reader,
    });

    expect(again.status).toBe(200);
    expect(again.body.count).toBe(0);
  });

  it("refuses to rate a draft the caller cannot see", async () => {
    const { status } = await api.request(`/api/stories/${draftSlug}/rating`, {
      method: "PUT",
      as: reader,
      body: { rating: 5 },
    });

    expect(status).toBe(404);
  });
});

describe.skipIf(!available)("the denormalised rating columns", () => {
  /**
   * The point of the columns is that `sort=rating` orders in SQL over the
   * story table, so they have to agree with the rows after any sequence of
   * writes -- not just after the first one.
   */
  it("matches a recomputed average after a series of writes", async () => {
    const story = await api.createStory({
      title: "Drift Check",
      authorId: author,
      // Seeded value, so the assertions below cannot pass by accident.
      ratingAverage: 4,
    });

    const scores = new Map<string, number>();

    async function rate(userId: string, rating: number) {
      await api.request(`/api/stories/${story.id}/rating`, {
        method: "PUT",
        as: userId,
        body: { rating },
      });
      scores.set(userId, rating);
      await expectStored();
    }

    async function withdraw(userId: string) {
      await api.request(`/api/stories/${story.id}/rating`, {
        method: "DELETE",
        as: userId,
      });
      scores.delete(userId);
      await expectStored();
    }

    /** Recomputes from what the suite believes it wrote, and compares. */
    async function expectStored() {
      const values = [...scores.values()];
      const expected =
        values.length === 0
          ? null
          : values.reduce((sum, value) => sum + value, 0) / values.length;

      const stored = await api.readStoryRating(story.id);

      expect(stored.count).toBe(values.length);
      if (expected === null) expect(stored.average).toBeNull();
      else expect(stored.average).toBeCloseTo(expected, 4);

      // And the read path agrees with the column it is allowed to bypass.
      const { body } = await api.request(`/api/stories/${story.id}/ratings`);
      expect(body.count).toBe(values.length);
      if (expected === null) expect(body.average).toBeNull();
      else expect(body.average).toBeCloseTo(expected, 4);
    }

    await rate(reader, 5);
    await rate(other, 2);
    await rate(author, 4);
    // An upsert, not a fourth row.
    await rate(reader, 1);
    await withdraw(other);
    await withdraw(author);
    await withdraw(reader);
  });

  it("clears the average rather than storing zero when the last rating goes", async () => {
    const story = await api.createStory({
      title: "Back To Nothing",
      authorId: author,
      ratingAverage: 3,
    });

    await api.request(`/api/stories/${story.id}/rating`, {
      method: "PUT",
      as: reader,
      body: { rating: 5 },
    });
    await api.request(`/api/stories/${story.id}/rating`, {
      method: "DELETE",
      as: reader,
    });

    const stored = await api.readStoryRating(story.id);

    expect(stored.count).toBe(0);
    expect(stored.average).toBeNull();
  });

  it("shows the new average on the story itself", async () => {
    const story = await api.createStory({
      title: "Story Payload",
      authorId: author,
      ratingAverage: 1,
    });

    await api.request(`/api/stories/${story.id}/rating`, {
      method: "PUT",
      as: reader,
      body: { rating: 5 },
    });
    await api.request(`/api/stories/${story.id}/rating`, {
      method: "PUT",
      as: other,
      body: { rating: 4 },
    });

    const { body } = await api.request(`/api/stories/${story.slug}`);

    expect(body.story.ratingCount).toBe(2);
    expect(body.story.ratingAverage).toBeCloseTo(4.5, 5);
  });
});
