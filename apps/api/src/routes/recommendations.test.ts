import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestApi, databaseAvailable } from "../test/harness.js";
import type {
  AuthorSuggestion,
  Recommendations,
} from "../services/recommendations.js";

const api = new TestApi();
const available = await databaseAvailable();

/**
 * These assertions are about *order*, never about membership of a fixed list.
 *
 * The candidate set is every listed Scribe story in the database, so a suite
 * that asserted "the rail is exactly these three" would pass on a developer's
 * empty database and fail the moment somebody ran `seed:stories`. What is
 * stable is the arithmetic: a story carrying a genre the reader named scores
 * 4 points for it, and nothing a seeded story can accumulate from quality,
 * popularity and freshness reaches that. So the fixtures below are compared
 * against each other, and seeded rows are free to sit wherever they land.
 */
function positionOf(list: Recommendations, storyId: string): number {
  return list.items.findIndex((item) => item.story.id === storyId);
}

/**
 * The same position, with "absent" read as "below everything".
 *
 * A story that scores badly enough falls off the end of the page rather than
 * sinking to the bottom of it, and that is a stronger outcome than being
 * ranked last -- so the comparisons below treat the two the same way instead
 * of insisting a demoted story still be on screen somewhere.
 */
function rankOf(list: Recommendations, storyId: string): number {
  const at = positionOf(list, storyId);
  return at === -1 ? Number.POSITIVE_INFINITY : at;
}

async function recommend(
  userId: string,
  query = "?limit=24",
): Promise<Recommendations> {
  const response = await api.request<Recommendations>(
    `/api/recommendations${query}`,
    { as: userId },
  );

  expect(response.status).toBe(200);
  return response.body;
}

/** One reader per concern: preferences are per account, and so is the ranking. */
let reader: string;
let newcomer: string;
let shelver: string;
let follower: string;
let author: string;
let other: string;

let saga: string;
let noir: string;

let sagaStory: { id: string; slug: string };
let noirStory: { id: string; slug: string };
let ownStory: { id: string; slug: string };
let draftStory: { id: string; slug: string };
let catalogueBook: string;
let finishedStory: { id: string; slug: string };
let finishedChapter: string;

beforeAll(async () => {
  if (!available) return;
  await api.start();

  // Short labels: `createUser` truncates the username to 30 characters.
  reader = await api.createUser("rr");
  newcomer = await api.createUser("rn");
  shelver = await api.createUser("rs");
  follower = await api.createUser("rf");
  author = await api.createUser("ra", { isAuthor: true });
  other = await api.createUser("ro", { isAuthor: true });

  saga = await api.createGenre("rec-saga");
  noir = await api.createGenre("rec-noir");

  sagaStory = await api.createStory({
    title: "The Long Saga",
    authorId: author,
    genreIds: [saga],
  });
  await api.createChapter({ storyId: sagaStory.id, number: 1 });

  noirStory = await api.createStory({
    title: "Rain On Glass",
    authorId: other,
    genreIds: [noir],
  });
  await api.createChapter({ storyId: noirStory.id, number: 1 });

  // The reader's own work, and somebody's unlisted draft: neither may ever
  // appear, whatever the reader's taste says.
  ownStory = await api.createStory({
    title: "Something I Wrote",
    authorId: reader,
    genreIds: [saga],
  });
  draftStory = await api.createStory({
    title: "Not Ready Yet",
    authorId: author,
    genreIds: [saga],
    listed: false,
  });

  // A catalogue edition in the same genre. It feeds the ranking through the
  // reader's shelf and is never a recommendation itself.
  catalogueBook = await api.createBook({
    title: "An Imported Edition",
    authorId: other,
    genreIds: [saga],
  });

  finishedStory = await api.createStory({
    title: "Already Read",
    authorId: other,
    genreIds: [saga],
  });
  finishedChapter = await api.createChapter({
    storyId: finishedStory.id,
    number: 1,
  });
}, 30_000);

afterAll(async () => {
  if (available) await api.stop();
});

describe.skipIf(!available)("cold start", () => {
  it("answers trending rather than an empty list", async () => {
    const list = await recommend(newcomer);

    expect(list.basis).toBe("trending");
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items[0]?.reason).toBe("Trending on Scribe");
  });

  it("switches to the personal path as soon as there is one signal", async () => {
    await api.setPreferences(newcomer, { genreIds: [noir] });

    const list = await recommend(newcomer);

    expect(list.basis).toBe("personal");
  });

  it("needs a session", async () => {
    const response = await api.request("/api/recommendations");

    expect(response.status).toBe(401);
  });

  it("refuses a limit past the ceiling", async () => {
    const response = await api.request("/api/recommendations?limit=500", {
      as: reader,
    });

    expect(response.status).toBe(400);
  });
});

describe.skipIf(!available)("preferred genres", () => {
  it("ranks a chosen genre above one that was not chosen", async () => {
    await api.setPreferences(reader, { genreIds: [saga] });

    const list = await recommend(reader);

    expect(positionOf(list, sagaStory.id)).toBeGreaterThanOrEqual(0);
    expect(rankOf(list, sagaStory.id)).toBeLessThan(rankOf(list, noirStory.id));
  });

  it("reverses when the reader changes their mind", async () => {
    await api.setPreferences(reader, { genreIds: [noir] });

    const list = await recommend(reader);

    expect(positionOf(list, noirStory.id)).toBeGreaterThanOrEqual(0);
    expect(rankOf(list, noirStory.id)).toBeLessThan(rankOf(list, sagaStory.id));
  });

  it("says which genre put a story there", async () => {
    const list = await recommend(reader);
    const item = list.items[positionOf(list, noirStory.id)];

    expect(item?.reason).toBe(`Because you like ${api.runId}-rec-noir`);
  });

  it("scores every item it returns", async () => {
    const list = await recommend(reader);

    for (const item of list.items) expect(item.score).toBeGreaterThan(0);
  });
});

describe.skipIf(!available)("what never comes back", () => {
  it("leaves out a story the reader has already read", async () => {
    await api.setPreferences(shelver, { genreIds: [saga] });

    // Before: it is a saga story like any other and the reader's genre is
    // saga, so it is on the rail.
    expect(
      positionOf(await recommend(shelver), finishedStory.id),
    ).toBeGreaterThanOrEqual(0);

    const saved = await api.request("/api/reading/progress", {
      method: "PUT",
      as: shelver,
      body: {
        storyId: finishedStory.id,
        chapterId: finishedChapter,
        offset: 10_000,
      },
    });
    expect(saved.status).toBe(200);

    const list = await recommend(shelver);

    expect(positionOf(list, finishedStory.id)).toBe(-1);
    // The control: reading one story excluded that story, not its genre.
    expect(positionOf(list, sagaStory.id)).toBeGreaterThanOrEqual(0);
  });

  it("leaves out a book the reader shelved as finished", async () => {
    const shelved = await api.request("/api/library", {
      method: "POST",
      as: shelver,
      body: { bookId: catalogueBook, status: "FINISHED" },
    });
    expect(shelved.status).toBe(201);
    api.track((shelved.body as { entry: { id: string } }).entry.id);

    const list = await recommend(shelver);

    // Excluded twice over -- by the shelf and by being a catalogue edition --
    // which is the honest state of this rule today: `POST /api/library` only
    // accepts catalogue rows, so a *story* reaches the "already met" filter
    // through reading history rather than through a shelf.
    expect(positionOf(list, catalogueBook)).toBe(-1);
  });

  it("leaves out the reader's own work", async () => {
    await api.setPreferences(reader, { genreIds: [saga] });

    const list = await recommend(reader);

    expect(positionOf(list, ownStory.id)).toBe(-1);
  });

  it("leaves out drafts", async () => {
    const list = await recommend(reader);

    expect(positionOf(list, draftStory.id)).toBe(-1);
  });

  it("leaves out catalogue editions", async () => {
    const list = await recommend(reader);

    expect(positionOf(list, catalogueBook)).toBe(-1);
    // Every item is a Scribe story, not only the fixture ones.
    for (const item of list.items) expect(item.story.source).toBe("SCRIBE");
  });
});

describe.skipIf(!available)("other signals", () => {
  it("lifts a story by somebody the reader follows", async () => {
    // No genre preference at all, so the follow is the only thing separating
    // these two stories -- one of which is by the followed author.
    await api.createFollow({ followerId: follower, followingId: author });

    const list = await recommend(follower);
    const sagaAt = positionOf(list, sagaStory.id);

    expect(sagaAt).toBeGreaterThanOrEqual(0);
    expect(sagaAt).toBeLessThan(rankOf(list, noirStory.id));
    expect(list.items[sagaAt]?.reason).toBe("New from " + api.usernameOf(author));
  });

  it("learns a genre from a shelf, without being told it", async () => {
    // The shelved row is a *catalogue* edition carrying the saga genre, so
    // this is the whole of the cross-source argument: imported books teach
    // the ranker what somebody likes even though they are never recommended.
    const shelved = await api.request("/api/library", {
      method: "POST",
      as: follower,
      body: { bookId: catalogueBook, status: "READING" },
    });
    expect(shelved.status).toBe(201);
    api.track((shelved.body as { entry: { id: string } }).entry.id);

    const list = await recommend(follower);

    expect(rankOf(list, sagaStory.id)).toBeLessThan(
      rankOf(list, noirStory.id),
    );
  });
});

describe.skipIf(!available)("author suggestions", () => {
  it("puts somebody who writes the reader's genres first", async () => {
    await api.setPreferences(reader, { genreIds: [saga] });

    const response = await api.request<{ authors: AuthorSuggestion[] }>(
      "/api/recommendations/authors?limit=24",
      { as: reader },
    );

    expect(response.status).toBe(200);
    expect(response.body.authors[0]?.id).toBe(author);
    expect(response.body.authors[0]?.storyCount).toBeGreaterThan(0);
  });

  it("leaves out the caller and anybody they already follow", async () => {
    const response = await api.request<{ authors: AuthorSuggestion[] }>(
      "/api/recommendations/authors?limit=24",
      { as: follower },
    );

    const ids = response.body.authors.map((suggestion) => suggestion.id);

    expect(ids).not.toContain(follower);
    // `follower` followed `author` in the suite above.
    expect(ids).not.toContain(author);
  });
});
