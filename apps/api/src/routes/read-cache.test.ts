import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TestApi, databaseAvailable } from "../test/harness.js";
import { db } from "../prisma/db.js";
import { invalidateReadCache } from "../lib/read-cache.js";

/**
 * The public read cache through real routes (`lib/read-cache.ts`).
 *
 * The rest of the suite runs with the cache off, so these are the tests that
 * say who is served a shared copy, who is not, and what clears it. The rows
 * are changed straight in the database to stand for "somebody else changed
 * it": a write that does not pass through a clearing route is exactly what
 * the cache is allowed to lag behind.
 */

const api = new TestApi();
const available = await databaseAvailable();

let authorId: string;
let readerId: string;
let otherReaderId: string;

async function retitleInDatabase(storyId: string, title: string): Promise<void> {
  await db.orm.content.Story.where((story) => story.id.eq(storyId)).update({ title });
}

describe.skipIf(!available)("public read cache", () => {
  beforeAll(async () => {
    await api.start();
    authorId = await api.createUser("ca");
    readerId = await api.createUser("cr");
    otherReaderId = await api.createUser("co");
  });

  afterAll(async () => {
    await api.stop();
  });

  beforeEach(() => {
    vi.stubEnv("READ_CACHE_SECONDS", "60");
    invalidateReadCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    invalidateReadCache();
  });

  it("serves readers, signed in or not, one shared copy of a story", async () => {
    const story = await api.createStory({ title: `Shared ${api.runId}`, authorId });

    const first = await api.request(`/api/stories/${story.slug}`, { as: readerId });
    await retitleInDatabase(story.id, `Changed ${api.runId}`);

    const again = await api.request(`/api/stories/${story.slug}`, { as: readerId });
    const anonymous = await api.request(`/api/stories/${story.slug}`);

    expect(first.body.story.title).toBe(`Shared ${api.runId}`);
    expect(again.body.story.title).toBe(`Shared ${api.runId}`);
    expect(anonymous.body.story.title).toBe(`Shared ${api.runId}`);
  });

  it("never serves an author the shared copy, so they see their own changes and drafts", async () => {
    const listed = await api.createStory({ title: `Mine ${api.runId}`, authorId });
    const draft = await api.createStory({ title: `Draft ${api.runId}`, authorId, listed: false });

    await api.request(`/api/stories/${listed.slug}`, { as: readerId });
    await retitleInDatabase(listed.id, `Mine, edited ${api.runId}`);

    const own = await api.request(`/api/stories/${listed.slug}`, { as: authorId });
    expect(own.body.story.title).toBe(`Mine, edited ${api.runId}`);

    // The 404 the public gets for a draft is not cached, and not served to
    // the author either.
    expect((await api.request(`/api/stories/${draft.slug}`)).status).toBe(404);
    expect((await api.request(`/api/stories/${draft.slug}`, { as: authorId })).status).toBe(200);
  });

  it("is cleared by an author's write, so readers see it at once", async () => {
    const story = await api.createStory({ title: `Before ${api.runId}`, authorId });
    await api.request(`/api/stories/${story.slug}`, { as: readerId });

    const patched = await api.request(`/api/author/stories/${story.id}`, {
      method: "PATCH",
      as: authorId,
      body: { title: `After ${api.runId}` },
    });
    expect(patched.status).toBe(200);

    const after = await api.request(`/api/stories/${story.slug}`, { as: readerId });
    expect(after.body.story.title).toBe(`After ${api.runId}`);
  });

  it("still records a view for every reader served from the cache", async () => {
    const story = await api.createStory({ title: `Counted ${api.runId}`, authorId });

    await api.request(`/api/stories/${story.slug}`, { as: readerId });
    await api.request(`/api/stories/${story.slug}`, { as: otherReaderId });
    await api.settleBackgroundWrites();

    expect(await api.countStoryViews(story.id)).toBe(2);
  });
});
