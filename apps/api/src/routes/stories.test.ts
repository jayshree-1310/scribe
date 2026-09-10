import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestApi, databaseAvailable } from "../test/harness.js";

const api = new TestApi();
const available = await databaseAvailable();

let authorId: string;
let otherAuthorId: string;
let readerId: string;
let genreId: string;
let otherGenreId: string;

/** Listed, three published chapters, one unpublished in the middle. */
let lanterns: { id: string; slug: string };
/** Listed, one published chapter, shares a genre with `lanterns`. */
let sibling: { id: string; slug: string };
/** A draft: `listedAt` is null. */
let draft: { id: string; slug: string };
/** A catalogue import, reachable by slug but absent from story lists. */
let importedId: string;

beforeAll(async () => {
  if (!available) return;
  await api.start();

  authorId = await api.createUser("lampwright");
  otherAuthorId = await api.createUser("astronomer");
  readerId = await api.createUser("reader");
  genreId = await api.createGenre("Lighthouses", 202);
  otherGenreId = await api.createGenre("Ledgers", 32);

  lanterns = await api.createStory({
    title: "The Lantern Keepers",
    authorId,
    genreIds: [genreId],
    viewCount: 900,
    likeCount: 90,
  });

  // Numbers 1, 2 and 4 are published; 3 is not. The gap is deliberate: it is
  // what the reader's prev/next links have to step over.
  await api.createChapter({ storyId: lanterns.id, number: 1, title: "Dark" });
  await api.createChapter({ storyId: lanterns.id, number: 2, title: "Harbour" });
  await api.createChapter({
    storyId: lanterns.id,
    number: 3,
    title: "Unfinished",
    published: false,
  });
  await api.createChapter({ storyId: lanterns.id, number: 4, title: "Sea" });

  sibling = await api.createStory({
    title: "Small Hours",
    authorId: otherAuthorId,
    genreIds: [genreId, otherGenreId],
    viewCount: 500,
    likeCount: 400,
  });
  await api.createChapter({ storyId: sibling.id, number: 1 });

  draft = await api.createStory({
    title: "Notes Toward a Longer Winter",
    authorId,
    genreIds: [otherGenreId],
    listed: false,
  });
  await api.createChapter({
    storyId: draft.id,
    number: 1,
    published: false,
  });

  importedId = await api.createBook({
    title: "A Gazetteer of Imported Editions",
    authorId: otherAuthorId,
    genreIds: [genreId],
  });
}, 30_000);

afterAll(async () => {
  if (available) await api.stop();
});

/* Discovery -------------------------------------------------------------- */

describe.skipIf(!available)("GET /api/stories", () => {
  it("lists listed stories with pagination metadata", async () => {
    const { status, body } = await api.request("/api/stories?limit=2");

    expect(status).toBe(200);
    expect(body.items.length).toBeLessThanOrEqual(2);
    expect(body).toMatchObject({ page: 1, limit: 2 });
    expect(body.total).toBeGreaterThanOrEqual(2);
  });

  it("excludes drafts from an anonymous caller", async () => {
    const { body } = await api.request(
      `/api/stories?search=${encodeURIComponent("Notes Toward a Longer Winter")}`,
    );

    expect(body.items).toHaveLength(0);
  });

  it("excludes drafts from a signed-in reader who is not the author", async () => {
    const { body } = await api.request(
      `/api/stories?search=${encodeURIComponent("Notes Toward a Longer Winter")}`,
      { as: readerId },
    );

    expect(body.items).toHaveLength(0);
  });

  it("shows an author their own draft", async () => {
    const { body } = await api.request(
      `/api/stories?search=${encodeURIComponent("Notes Toward a Longer Winter")}`,
      { as: authorId },
    );

    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ slug: draft.slug, status: "draft" });
  });

  it("leaves catalogue imports to /api/books", async () => {
    const { body } = await api.request(
      `/api/stories?search=${encodeURIComponent("A Gazetteer of Imported Editions")}`,
    );

    expect(body.items).toHaveLength(0);
  });

  it("filters by genre", async () => {
    const { body } = await api.request(`/api/stories?genreId=${otherGenreId}`);
    const slugs = body.items.map((story: { slug: string }) => story.slug);

    expect(slugs).toContain(sibling.slug);
    expect(slugs).not.toContain(lanterns.slug);
  });

  it("sorts by engagement for trending and by traffic for views", async () => {
    const trending = await api.request(`/api/stories?genreId=${genreId}&sort=trending`);
    const views = await api.request(`/api/stories?genreId=${genreId}&sort=views`);

    // `sibling` has more likes, `lanterns` more views.
    expect(trending.body.items[0].slug).toBe(sibling.slug);
    expect(views.body.items[0].slug).toBe(lanterns.slug);
  });

  it("filters by author, and shows that author their own drafts", async () => {
    const anonymous = await api.request(`/api/stories?authorId=${authorId}`);
    const owner = await api.request(`/api/stories?authorId=${authorId}`, {
      as: authorId,
    });

    const listed = anonymous.body.items.map((story: { slug: string }) => story.slug);
    const own = owner.body.items.map((story: { slug: string }) => story.slug);

    expect(listed).toContain(lanterns.slug);
    expect(listed).not.toContain(draft.slug);
    // Same query, asked by the author: their draft is included.
    expect(own).toContain(draft.slug);
    // Never another author's work.
    expect(own).not.toContain(sibling.slug);
  });

  it("rejects an unparseable page", async () => {
    const { status, body } = await api.request("/api/stories?page=abc");

    expect(status).toBe(400);
    expect(body.error.details).toHaveProperty("page");
  });
});

describe.skipIf(!available)("GET /api/stories/genres", () => {
  it("counts only listed authored stories", async () => {
    const { status, body } = await api.request("/api/stories/genres");
    expect(status).toBe(200);

    const lighthouses = body.genres.find(
      (genre: { id: string }) => genre.id === genreId,
    );
    const ledgers = body.genres.find(
      (genre: { id: string }) => genre.id === otherGenreId,
    );

    // Two listed stories carry "Lighthouses"; the catalogue import that also
    // carries it does not count here.
    expect(lighthouses.storyCount).toBe(2);
    // "Ledgers" is on one listed story and one draft.
    expect(ledgers.storyCount).toBe(1);
  });
});

/* One story -------------------------------------------------------------- */

describe.skipIf(!available)("GET /api/stories/:slug", () => {
  it("finds a story by slug", async () => {
    const { status, body } = await api.request(`/api/stories/${lanterns.slug}`);

    expect(status).toBe(200);
    expect(body.story).toMatchObject({
      id: lanterns.id,
      slug: lanterns.slug,
      title: "The Lantern Keepers",
      source: "SCRIBE",
      status: "ongoing",
    });
    expect(body.story.author).toMatchObject({ id: authorId });
    expect(body.story.genres).toHaveLength(1);
  });

  it("finds the same story by id", async () => {
    const { status, body } = await api.request(`/api/stories/${lanterns.id}`);

    expect(status).toBe(200);
    expect(body.story.slug).toBe(lanterns.slug);
  });

  it("counts only readable chapters, and their words", async () => {
    const anonymous = await api.request(`/api/stories/${lanterns.slug}`);
    const owner = await api.request(`/api/stories/${lanterns.slug}`, {
      as: authorId,
    });

    // Three of the four chapters are published.
    expect(anonymous.body.story.chapterCount).toBe(3);
    expect(owner.body.story.chapterCount).toBe(4);
    expect(anonymous.body.story.wordCount).toBeGreaterThan(0);
    expect(owner.body.story.wordCount).toBeGreaterThan(
      anonymous.body.story.wordCount,
    );
  });

  it("computes the rating average from real rows", async () => {
    const rated = await api.createStory({ title: "Rated", authorId });
    await api.createRating({ userId: readerId, storyId: rated.id, rating: 5 });
    await api.createRating({ userId: authorId, storyId: rated.id, rating: 3 });

    const { body } = await api.request(`/api/stories/${rated.slug}`);

    expect(body.story.ratingCount).toBe(2);
    expect(body.story.ratingAverage).toBeCloseTo(4);
  });

  it("hides a draft from everyone but its author", async () => {
    const anonymous = await api.request(`/api/stories/${draft.slug}`);
    const stranger = await api.request(`/api/stories/${draft.slug}`, {
      as: readerId,
    });
    const owner = await api.request(`/api/stories/${draft.slug}`, {
      as: authorId,
    });

    expect(anonymous.status).toBe(404);
    expect(stranger.status).toBe(404);
    expect(owner.status).toBe(200);
    expect(owner.body.story.status).toBe("draft");
  });

  it("still serves a catalogue import by slug, so /story/:slug never dead-ends", async () => {
    const { body: books } = await api.request(`/api/books/${importedId}`);
    const { status } = await api.request(`/api/stories/${books.book.id}`);

    expect(status).toBe(200);
  });

  it("404s on an unknown slug", async () => {
    const { status, body } = await api.request("/api/stories/not-a-real-story");

    expect(status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  it("404s on a well-formed id that does not exist", async () => {
    const { status } = await api.request(
      "/api/stories/00000000-0000-4000-8000-000000000999",
    );

    expect(status).toBe(404);
  });
});

/* Chapters --------------------------------------------------------------- */

describe.skipIf(!available)("GET /api/stories/:slug/chapters", () => {
  it("returns published chapters in reading order, without bodies", async () => {
    const { status, body } = await api.request(
      `/api/stories/${lanterns.slug}/chapters`,
    );

    expect(status).toBe(200);
    expect(body.chapters.map((chapter: { number: number }) => chapter.number)).toEqual([
      1, 2, 4,
    ]);
    expect(body.chapters[0]).not.toHaveProperty("content");
    expect(body.chapters[0].wordCount).toBeGreaterThan(0);
  });

  it("includes the author's unpublished chapter for the author", async () => {
    const { body } = await api.request(
      `/api/stories/${lanterns.slug}/chapters`,
      { as: authorId },
    );

    expect(body.chapters.map((chapter: { number: number }) => chapter.number)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("404s for a draft's chapters when the caller is not the author", async () => {
    const { status } = await api.request(`/api/stories/${draft.slug}/chapters`);
    expect(status).toBe(404);
  });
});

describe.skipIf(!available)("GET /api/stories/:slug/chapters/:number", () => {
  it("returns one chapter with its body", async () => {
    const { status, body } = await api.request(
      `/api/stories/${lanterns.slug}/chapters/1`,
    );

    expect(status).toBe(200);
    expect(body.chapter).toMatchObject({ number: 1, title: "Dark" });
    expect(body.chapter.content).toContain("chapter 1");
  });

  it("has no previous chapter on the first", async () => {
    const { body } = await api.request(
      `/api/stories/${lanterns.slug}/chapters/1`,
    );

    expect(body.chapter.previousNumber).toBeNull();
    expect(body.chapter.nextNumber).toBe(2);
  });

  it("has no next chapter on the last", async () => {
    const { body } = await api.request(
      `/api/stories/${lanterns.slug}/chapters/4`,
    );

    expect(body.chapter.nextNumber).toBeNull();
    // Chapter 3 is unpublished, so an anonymous reader steps back over it.
    expect(body.chapter.previousNumber).toBe(2);
  });

  it("steps over an unpublished chapter in the middle", async () => {
    const { body } = await api.request(
      `/api/stories/${lanterns.slug}/chapters/2`,
    );

    expect(body.chapter.nextNumber).toBe(4);
  });

  it("does not step over it for the author, who can read it", async () => {
    const { body } = await api.request(
      `/api/stories/${lanterns.slug}/chapters/2`,
      { as: authorId },
    );

    expect(body.chapter.nextNumber).toBe(3);
  });

  it("404s on an unpublished chapter for a reader", async () => {
    const anonymous = await api.request(
      `/api/stories/${lanterns.slug}/chapters/3`,
    );
    const owner = await api.request(
      `/api/stories/${lanterns.slug}/chapters/3`,
      { as: authorId },
    );

    expect(anonymous.status).toBe(404);
    expect(owner.status).toBe(200);
  });

  it("404s past the last chapter", async () => {
    const { status } = await api.request(
      `/api/stories/${lanterns.slug}/chapters/99`,
    );

    expect(status).toBe(404);
  });

  it("rejects a chapter number that is not a number", async () => {
    const { status } = await api.request(
      `/api/stories/${lanterns.slug}/chapters/two`,
    );

    expect(status).toBe(400);
  });

  it("returns attached multimedia in display order", async () => {
    const story = await api.createStory({ title: "Illustrated", authorId });
    const chapterId = await api.createChapter({
      storyId: story.id,
      number: 1,
    });
    await api.createMultimedia({
      chapterId,
      type: "AUDIO",
      url: "https://example.invalid/second.mp3",
      displayOrder: 2,
    });
    await api.createMultimedia({
      chapterId,
      type: "IMAGE",
      url: "https://example.invalid/first.png",
      displayOrder: 1,
    });

    const { body } = await api.request(
      `/api/stories/${story.slug}/chapters/1`,
    );

    expect(body.chapter.multimedia.map((item: { type: string }) => item.type)).toEqual([
      "IMAGE",
      "AUDIO",
    ]);
  });
});

/* Related ---------------------------------------------------------------- */

describe.skipIf(!available)("GET /api/stories/:slug/related", () => {
  it("returns listed stories sharing a genre, never the story itself", async () => {
    const { status, body } = await api.request(
      `/api/stories/${lanterns.slug}/related`,
    );

    expect(status).toBe(200);
    const slugs = body.stories.map((story: { slug: string }) => story.slug);
    expect(slugs).toContain(sibling.slug);
    expect(slugs).not.toContain(lanterns.slug);
  });

  it("excludes the caller's own drafts, which are not recommendations", async () => {
    const { body } = await api.request(`/api/stories/${sibling.slug}/related`, {
      as: authorId,
    });

    const slugs = body.stories.map((story: { slug: string }) => story.slug);
    expect(slugs).not.toContain(draft.slug);
  });

  it("404s on an unknown story", async () => {
    const { status } = await api.request("/api/stories/nope/related");
    expect(status).toBe(404);
  });
});
