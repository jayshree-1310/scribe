import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestApi, databaseAvailable } from "../test/harness.js";
import { db } from "../prisma/db.js";

const api = new TestApi();
const available = await databaseAvailable();

let authorId: string;
let intruderId: string;
let genreId: string;
let otherGenreId: string;

/**
 * Titles carry the run id so the slug the API derives cannot collide with a
 * seeded story -- a collision would still pass, via the uniqueness suffix, but
 * it would stop the slug assertions from meaning anything.
 */
function title(name: string): string {
  return `${name} ${api.runId}`;
}

/** Creates a story through the API and returns the body's story. */
async function newStory(
  overrides: Record<string, unknown> = {},
  as = authorId,
): Promise<any> {
  const { status, body } = await api.request("/api/author/stories", {
    method: "POST",
    as,
    body: { title: title("Untitled"), ...overrides },
  });

  expect(status).toBe(201);
  return body.story;
}

async function newChapter(
  storyId: string,
  body: Record<string, unknown>,
  as = authorId,
): Promise<any> {
  const response = await api.request(
    `/api/author/stories/${storyId}/chapters`,
    { method: "POST", as, body },
  );

  expect(response.status).toBe(201);
  return response.body.chapter;
}

/** Chapter numbers of one story, in the order the author sees them. */
async function numbersOf(storyId: string): Promise<number[]> {
  const { body } = await api.request(
    `/api/author/stories/${storyId}/chapters`,
    { as: authorId },
  );

  return body.chapters.map((chapter: { number: number }) => chapter.number);
}

beforeAll(async () => {
  if (!available) return;
  await api.start();

  authorId = await api.createUser("scrivener");
  intruderId = await api.createUser("interloper");
  genreId = await api.createGenre("Estuaries", 190);
  otherGenreId = await api.createGenre("Almanacs", 40);
}, 30_000);

afterAll(async () => {
  if (!available) return;
  await api.stop();
}, 30_000);

/* Access ----------------------------------------------------------------- */

describe.skipIf(!available)("/api/author access", () => {
  it("401s an anonymous caller", async () => {
    const { status } = await api.request("/api/author/stories");
    expect(status).toBe(401);
  });

  it("403s every write against somebody else's story", async () => {
    const story = await newStory({ title: title("Not Yours") });
    const chapter = await newChapter(story.id, { title: "One", content: "A word." });

    const writes: Array<[string, string, unknown?]> = [
      ["PATCH", `/api/author/stories/${story.id}`, { title: "Hijacked" }],
      ["DELETE", `/api/author/stories/${story.id}`],
      ["POST", `/api/author/stories/${story.id}/publish`],
      ["POST", `/api/author/stories/${story.id}/unpublish`],
      ["POST", `/api/author/stories/${story.id}/chapters`, { title: "Theirs" }],
      [
        "POST",
        `/api/author/stories/${story.id}/chapters/reorder`,
        { chapterIds: [chapter.id] },
      ],
      ["PATCH", `/api/author/chapters/${chapter.id}`, { title: "Theirs" }],
      ["DELETE", `/api/author/chapters/${chapter.id}`],
      ["POST", `/api/author/chapters/${chapter.id}/publish`],
      ["POST", `/api/author/chapters/${chapter.id}/unpublish`],
      [
        "POST",
        `/api/author/chapters/${chapter.id}/multimedia`,
        { type: "IMAGE", url: "https://example.invalid/x.png" },
      ],
    ];

    for (const [method, path, body] of writes) {
      const { status } = await api.request(path, {
        method,
        as: intruderId,
        ...(body === undefined ? {} : { body }),
      });

      expect(status, `${method} ${path}`).toBe(403);
    }

    // And the story is untouched by the attempt.
    const { body } = await api.request(`/api/author/stories/${story.id}/chapters`, {
      as: authorId,
    });
    expect(body.chapters).toHaveLength(1);
  });

  it("403s an attachment belonging to another author's chapter", async () => {
    const story = await newStory({ title: title("Guarded Media") });
    const chapter = await newChapter(story.id, { title: "One", content: "Word." });

    const { body } = await api.request(
      `/api/author/chapters/${chapter.id}/multimedia`,
      {
        method: "POST",
        as: authorId,
        body: { type: "AUDIO", url: "https://example.invalid/a.mp3" },
      },
    );

    const { status } = await api.request(
      `/api/author/multimedia/${body.multimedia.id}`,
      { method: "DELETE", as: intruderId },
    );

    expect(status).toBe(403);
  });

  it("404s a story that does not exist, rather than 403", async () => {
    const { status } = await api.request(
      "/api/author/stories/00000000-0000-4000-8000-0000000000ff",
      { method: "PATCH", as: authorId, body: { title: "Ghost" } },
    );

    expect(status).toBe(404);
  });

  it("refuses to edit a catalogue edition through the authoring API", async () => {
    const bookId = await api.createBook({
      title: title("An Imported Edition"),
      authorId,
    });

    const { status } = await api.request(`/api/author/stories/${bookId}`, {
      method: "PATCH",
      as: authorId,
      body: { title: "Rewritten" },
    });

    expect(status).toBe(403);
  });
});

/* Stories ---------------------------------------------------------------- */

describe.skipIf(!available)("POST /api/author/stories", () => {
  it("creates a draft with a slug derived from the title", async () => {
    const story = await newStory({
      title: title("The Weir at Low Water"),
      description: "A survey of one river's locks.",
      genreIds: [genreId],
    });

    expect(story.status).toBe("draft");
    expect(story.listedAt).toBeNull();
    expect(story.source).toBe("SCRIBE");
    expect(story.slug).toContain("the-weir-at-low-water");
    expect(story.genres.map((genre: { id: string }) => genre.id)).toEqual([genreId]);
  });

  it("suffixes a slug that is already taken rather than failing", async () => {
    const shared = title("Twice Told");

    const first = await newStory({ title: shared });
    const second = await newStory({ title: shared });

    expect(second.slug).not.toBe(first.slug);
    expect(second.slug).toBe(`${first.slug}-2`);
  });

  it("makes the caller an author, which nothing else does", async () => {
    const fresh = await api.createUser("first-timer");

    const before = await db.orm.auth.User.select("isAuthor")
      .where((user) => user.id.eq(fresh))
      .first();
    expect(before?.isAuthor).toBe(false);

    await newStory({ title: title("A First Attempt") }, fresh);

    const after = await db.orm.auth.User.select("isAuthor")
      .where((user) => user.id.eq(fresh))
      .first();
    expect(after?.isAuthor).toBe(true);
  });

  it("rejects an empty title", async () => {
    const { status, body } = await api.request("/api/author/stories", {
      method: "POST",
      as: authorId,
      body: { title: "   " },
    });

    expect(status).toBe(400);
    expect(body.error.details.title).toBeDefined();
  });
});

describe.skipIf(!available)("PATCH /api/author/stories/:id", () => {
  it("re-derives the slug while the story is still a draft", async () => {
    const story = await newStory({ title: title("Working Title") });

    const { body } = await api.request(`/api/author/stories/${story.id}`, {
      method: "PATCH",
      as: authorId,
      body: { title: title("The Real Title") },
    });

    expect(body.story.slug).toContain("the-real-title");
  });

  it("keeps a published story's slug when the title changes", async () => {
    const story = await newStory({ title: title("Already Out") });
    const chapter = await newChapter(story.id, { title: "One", content: "Words here." });

    await api.request(`/api/author/chapters/${chapter.id}/publish`, {
      method: "POST",
      as: authorId,
    });
    await api.request(`/api/author/stories/${story.id}/publish`, {
      method: "POST",
      as: authorId,
    });

    const { body } = await api.request(`/api/author/stories/${story.id}`, {
      method: "PATCH",
      as: authorId,
      body: { title: title("Renamed After Release") },
    });

    expect(body.story.title).toContain("Renamed After Release");
    expect(body.story.slug).toBe(story.slug);
  });

  it("replaces the whole genre set", async () => {
    const story = await newStory({
      title: title("Reclassified"),
      genreIds: [genreId],
    });

    const { body } = await api.request(`/api/author/stories/${story.id}`, {
      method: "PATCH",
      as: authorId,
      body: { genreIds: [otherGenreId] },
    });

    expect(body.story.genres.map((genre: { id: string }) => genre.id)).toEqual([
      otherGenreId,
    ]);
  });

  it("rejects an unknown genre without changing the set", async () => {
    const story = await newStory({
      title: title("Kept As Is"),
      genreIds: [genreId],
    });

    const { status } = await api.request(`/api/author/stories/${story.id}`, {
      method: "PATCH",
      as: authorId,
      body: { genreIds: ["00000000-0000-4000-8000-0000000000aa"] },
    });

    expect(status).toBe(400);

    const { body } = await api.request(`/api/stories/${story.slug}`, {
      as: authorId,
    });
    expect(body.story.genres.map((genre: { id: string }) => genre.id)).toEqual([
      genreId,
    ]);
  });

  it("rejects an empty patch", async () => {
    const story = await newStory({ title: title("Nothing To Say") });

    const { status } = await api.request(`/api/author/stories/${story.id}`, {
      method: "PATCH",
      as: authorId,
      body: {},
    });

    expect(status).toBe(400);
  });
});

describe.skipIf(!available)("DELETE /api/author/stories/:id", () => {
  it("removes the story, its chapters and everything hanging off them", async () => {
    const story = await newStory({
      title: title("To Be Withdrawn"),
      genreIds: [genreId],
    });
    const chapter = await newChapter(story.id, { title: "One", content: "A line." });

    await api.request(`/api/author/chapters/${chapter.id}/multimedia`, {
      method: "POST",
      as: authorId,
      body: { type: "IMAGE", url: "https://example.invalid/plate.png" },
    });
    await api.createRating({ userId: intruderId, storyId: story.id, rating: 4 });

    const { status } = await api.request(`/api/author/stories/${story.id}`, {
      method: "DELETE",
      as: authorId,
    });
    expect(status).toBe(204);

    const chapters = await db.orm.content.Chapter.select("id")
      .where((row) => row.storyId.eq(story.id))
      .all();
    expect(chapters).toHaveLength(0);

    const media = await db.orm.content.Multimedia.select("id")
      .where((row) => row.chapterId.eq(chapter.id))
      .all();
    expect(media).toHaveLength(0);

    const gone = await api.request(`/api/stories/${story.slug}`, { as: authorId });
    expect(gone.status).toBe(404);
  });
});

/* Chapters --------------------------------------------------------------- */

describe.skipIf(!available)("chapter writes", () => {
  it("appends chapters, numbering them contiguously from 1", async () => {
    const story = await newStory({ title: title("Serialised") });

    for (const name of ["One", "Two", "Three"]) {
      await newChapter(story.id, { title: name, content: `Body of ${name}.` });
    }

    expect(await numbersOf(story.id)).toEqual([1, 2, 3]);
  });

  it("maintains wordCount on every content write", async () => {
    const story = await newStory({ title: title("Counted") });
    const chapter = await newChapter(story.id, {
      title: "One",
      content: "One two three four five",
    });

    expect(chapter.wordCount).toBe(5);

    const { body } = await api.request(`/api/author/chapters/${chapter.id}`, {
      method: "PATCH",
      as: authorId,
      body: { content: "Shorter now" },
    });

    expect(body.chapter.wordCount).toBe(2);

    const emptied = await api.request(`/api/author/chapters/${chapter.id}`, {
      method: "PATCH",
      as: authorId,
      body: { content: "   \n  " },
    });

    expect(emptied.body.chapter.wordCount).toBe(0);
  });

  it("closes the gap after a mid-list delete", async () => {
    const story = await newStory({ title: title("Four Then Three") });

    const created = [];
    for (const name of ["One", "Two", "Three", "Four"]) {
      created.push(await newChapter(story.id, { title: name, content: name }));
    }

    const { status, body } = await api.request(
      `/api/author/chapters/${created[1]!.id}`,
      { method: "DELETE", as: authorId },
    );

    expect(status).toBe(200);
    expect(body.chapters.map((chapter: { number: number }) => chapter.number)).toEqual([
      1, 2, 3,
    ]);
    expect(body.chapters.map((chapter: { title: string }) => chapter.title)).toEqual([
      "One",
      "Three",
      "Four",
    ]);
  });

  it("reorders to exactly the list it is given", async () => {
    const story = await newStory({ title: title("Shuffled") });

    const created = [];
    for (const name of ["One", "Two", "Three"]) {
      created.push(await newChapter(story.id, { title: name, content: name }));
    }

    const reversed = [created[2]!.id, created[0]!.id, created[1]!.id];

    const { status, body } = await api.request(
      `/api/author/stories/${story.id}/chapters/reorder`,
      { method: "POST", as: authorId, body: { chapterIds: reversed } },
    );

    expect(status).toBe(200);
    expect(body.chapters.map((chapter: { number: number }) => chapter.number)).toEqual([
      1, 2, 3,
    ]);
    expect(body.chapters.map((chapter: { id: string }) => chapter.id)).toEqual(
      reversed,
    );

    // And a second reorder back is just as clean -- the negative pass left
    // nothing behind.
    const back = await api.request(
      `/api/author/stories/${story.id}/chapters/reorder`,
      {
        method: "POST",
        as: authorId,
        body: { chapterIds: created.map((chapter) => chapter.id) },
      },
    );

    expect(back.body.chapters.map((chapter: { number: number }) => chapter.number)).toEqual(
      [1, 2, 3],
    );
    expect(await numbersOf(story.id)).toEqual([1, 2, 3]);
  });

  it("rejects a partial or duplicated reorder", async () => {
    const story = await newStory({ title: title("All Or Nothing") });
    const first = await newChapter(story.id, { title: "One", content: "One" });
    await newChapter(story.id, { title: "Two", content: "Two" });

    const partial = await api.request(
      `/api/author/stories/${story.id}/chapters/reorder`,
      { method: "POST", as: authorId, body: { chapterIds: [first.id] } },
    );
    expect(partial.status).toBe(400);

    const duplicated = await api.request(
      `/api/author/stories/${story.id}/chapters/reorder`,
      {
        method: "POST",
        as: authorId,
        body: { chapterIds: [first.id, first.id] },
      },
    );
    expect(duplicated.status).toBe(400);

    // Untouched by either attempt.
    expect(await numbersOf(story.id)).toEqual([1, 2]);
  });
});

/* Publication ------------------------------------------------------------ */

describe.skipIf(!available)("publish and unpublish", () => {
  it("refuses to list a story with nothing published in it", async () => {
    const story = await newStory({ title: title("Empty Shelf") });
    await newChapter(story.id, { title: "One", content: "Written but held back." });

    const { status, body } = await api.request(
      `/api/author/stories/${story.id}/publish`,
      { method: "POST", as: authorId },
    );

    expect(status).toBe(400);
    expect(body.error.details.chapters).toBeDefined();
  });

  it("refuses to publish an empty chapter", async () => {
    const story = await newStory({ title: title("Blank Page") });
    const chapter = await newChapter(story.id, { title: "One" });

    const { status } = await api.request(
      `/api/author/chapters/${chapter.id}/publish`,
      { method: "POST", as: authorId },
    );

    expect(status).toBe(400);
  });

  it("makes a published story readable, and an unpublished one invisible again", async () => {
    const story = await newStory({ title: title("In And Out Of Print") });
    const chapter = await newChapter(story.id, {
      title: "One",
      content: "The tide came in.",
    });

    // A draft is invisible to everyone but its author.
    const hidden = await api.request(`/api/stories/${story.slug}`);
    expect(hidden.status).toBe(404);

    await api.request(`/api/author/chapters/${chapter.id}/publish`, {
      method: "POST",
      as: authorId,
    });

    const published = await api.request(
      `/api/author/stories/${story.id}/publish`,
      { method: "POST", as: authorId },
    );
    expect(published.body.story.status).toBe("ongoing");

    const visible = await api.request(`/api/stories/${story.slug}`);
    expect(visible.status).toBe(200);
    expect(visible.body.story.chapterCount).toBe(1);

    const withdrawn = await api.request(
      `/api/author/stories/${story.id}/unpublish`,
      { method: "POST", as: authorId },
    );
    expect(withdrawn.body.story.status).toBe("draft");

    const gone = await api.request(`/api/stories/${story.slug}`);
    expect(gone.status).toBe(404);
  });

  it("keeps the original listing date when a story is published again", async () => {
    const story = await newStory({ title: title("Reissued") });
    const chapter = await newChapter(story.id, { title: "One", content: "Words." });

    await api.request(`/api/author/chapters/${chapter.id}/publish`, {
      method: "POST",
      as: authorId,
    });
    const first = await api.request(`/api/author/stories/${story.id}/publish`, {
      method: "POST",
      as: authorId,
    });

    const again = await api.request(`/api/author/stories/${story.id}/publish`, {
      method: "POST",
      as: authorId,
    });

    expect(again.body.story.listedAt).toBe(first.body.story.listedAt);
  });

  it("hides an unpublished chapter from readers but not from its author", async () => {
    const story = await newStory({ title: title("One Held Back") });
    const first = await newChapter(story.id, { title: "One", content: "Out." });
    const second = await newChapter(story.id, { title: "Two", content: "Not yet." });

    await api.request(`/api/author/chapters/${first.id}/publish`, {
      method: "POST",
      as: authorId,
    });
    await api.request(`/api/author/stories/${story.id}/publish`, {
      method: "POST",
      as: authorId,
    });

    const reader = await api.request(`/api/stories/${story.slug}/chapters`);
    expect(reader.body.chapters.map((chapter: { id: string }) => chapter.id)).toEqual([
      first.id,
    ]);

    const author = await api.request(`/api/stories/${story.slug}/chapters`, {
      as: authorId,
    });
    expect(author.body.chapters).toHaveLength(2);

    // Publishing the second one brings it into the reader's list.
    await api.request(`/api/author/chapters/${second.id}/publish`, {
      method: "POST",
      as: authorId,
    });

    const after = await api.request(`/api/stories/${story.slug}/chapters`);
    expect(after.body.chapters).toHaveLength(2);

    // And unpublishing it takes it straight back out.
    await api.request(`/api/author/chapters/${second.id}/unpublish`, {
      method: "POST",
      as: authorId,
    });

    const withdrawn = await api.request(`/api/stories/${story.slug}/chapters`);
    expect(withdrawn.body.chapters).toHaveLength(1);
  });
});

/* Listing ---------------------------------------------------------------- */

describe.skipIf(!available)("GET /api/author/stories", () => {
  it("returns the caller's own stories, drafts included", async () => {
    const author = await api.createUser("lister");
    const draft = await newStory({ title: title("Held Back") }, author);
    const listed = await newStory({ title: title("Out There") }, author);
    const chapter = await newChapter(listed.id, { title: "One", content: "Go." }, author);

    await api.request(`/api/author/chapters/${chapter.id}/publish`, {
      method: "POST",
      as: author,
    });
    await api.request(`/api/author/stories/${listed.id}/publish`, {
      method: "POST",
      as: author,
    });

    const { status, body } = await api.request("/api/author/stories", {
      as: author,
    });

    expect(status).toBe(200);
    const ids = body.items.map((story: { id: string }) => story.id);
    expect(ids).toContain(draft.id);
    expect(ids).toContain(listed.id);
    expect(body.total).toBe(2);
  });

  it("never returns another author's stories", async () => {
    const { body } = await api.request("/api/author/stories", { as: intruderId });

    expect(
      body.items.every(
        (story: { author: { id: string } }) => story.author.id === intruderId,
      ),
    ).toBe(true);
  });
});

/* Multimedia ------------------------------------------------------------- */

describe.skipIf(!available)("chapter multimedia", () => {
  it("appends attachments in order and removes them again", async () => {
    const story = await newStory({ title: title("Illustrated") });
    const chapter = await newChapter(story.id, { title: "One", content: "Plate." });

    const first = await api.request(
      `/api/author/chapters/${chapter.id}/multimedia`,
      {
        method: "POST",
        as: authorId,
        body: { type: "IMAGE", url: "https://example.invalid/one.png" },
      },
    );
    const second = await api.request(
      `/api/author/chapters/${chapter.id}/multimedia`,
      {
        method: "POST",
        as: authorId,
        body: { type: "AUDIO", url: "https://example.invalid/two.mp3" },
      },
    );

    expect(first.status).toBe(201);
    expect(first.body.multimedia.displayOrder).toBe(0);
    expect(second.body.multimedia.displayOrder).toBe(1);

    await api.request(`/api/author/chapters/${chapter.id}/publish`, {
      method: "POST",
      as: authorId,
    });
    await api.request(`/api/author/stories/${story.id}/publish`, {
      method: "POST",
      as: authorId,
    });

    const reader = await api.request(`/api/stories/${story.slug}/chapters/1`);
    expect(
      reader.body.chapter.multimedia.map((item: { type: string }) => item.type),
    ).toEqual(["IMAGE", "AUDIO"]);

    const removed = await api.request(
      `/api/author/multimedia/${first.body.multimedia.id}`,
      { method: "DELETE", as: authorId },
    );
    expect(removed.status).toBe(204);

    const after = await api.request(`/api/stories/${story.slug}/chapters/1`);
    expect(after.body.chapter.multimedia).toHaveLength(1);
  });

  it("rejects a media type the contract does not have", async () => {
    const story = await newStory({ title: title("Bad Media") });
    const chapter = await newChapter(story.id, { title: "One", content: "Word." });

    const { status } = await api.request(
      `/api/author/chapters/${chapter.id}/multimedia`,
      {
        method: "POST",
        as: authorId,
        body: { type: "HOLOGRAM", url: "https://example.invalid/x" },
      },
    );

    expect(status).toBe(400);
  });
});
