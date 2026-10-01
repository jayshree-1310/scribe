/**
 * Hybrid search end to end, against the real database and a fake embedder.
 *
 * The fake knows a handful of concepts (`CONCEPTS`): any word in a concept's
 * list embeds onto that concept's axis, so "mourning" and "funeral" come out
 * identical and an unrelated passage comes out far away. That is enough to
 * test what this feature is responsible for -- that search *uses* nearness
 * correctly, inherits visibility, and fuses rankings as documented -- without
 * asserting anything about a real model's sense of meaning.
 *
 * The fake has its own model name, and search filters stored rows by model, so
 * this suite sees only the rows it embedded: the dev database's real
 * `nomic-embed-text` rows, and the `fake-embed` rows other suites write, are
 * invisible to it.
 */

/** See `ai.test.ts`: `lib/redis.ts` reads `REDIS_URL` at module scope. */
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
import { HttpError } from "../lib/http-error.js";
import { connectRedis, redis } from "../lib/redis.js";
import { embedChapter } from "../services/ai/embeddings.js";
import { resetAiEmbedder, setAiEmbedder } from "../services/ai/provider.js";
import { QUERY_LIMIT } from "../services/ai/search.js";
import { fakeAiEmbedder, type FakeAiEmbedder } from "../services/ai/testing.js";
import { TestApi, databaseAvailable } from "../test/harness.js";

const api = new TestApi();
const available = await databaseAvailable();

const CONCEPTS = {
  grief: ["grief", "mourning", "funeral", "bereaved"],
  // "quillmoor" is the invented place name the hybrid fixtures share, both as
  // a title keyword and as a word that means "lighthouse" to this fake.
  beacon: ["quillmoor", "lighthouse", "beacon"],
};

/** Long enough to chunk into more than one window. */
function prose(sentence: string): string {
  return Array.from(
    { length: 6 },
    (_, index) =>
      `${sentence} This was the ${index + 1}th time she had thought about it, ` +
      "and the kitchen clock kept its own counsel on the wall above the sink. ".repeat(3),
  ).join("\n");
}

const UNRELATED = prose("The accounts did not balance and the ledger was late.");

let authorId: string;
let readerId: string;
let genreId: string;
let embedder: FakeAiEmbedder;

/** Ids by role, so assertions read as the scenario they test. */
const ids = {
  synonym: "",
  draft: "",
  hiddenChapterStory: "",
  both: "",
  keywordOnly: "",
  meaningOnly: "",
  otherGenre: "",
};

/** A published chapter, embedded through the real pass. */
async function chapterOf(
  storyId: string,
  number: number,
  content: string,
  published = true,
): Promise<string> {
  const id = await api.createChapter({
    storyId,
    number,
    title: `Part ${number}`,
    content,
    published,
  });
  await embedChapter({ id, storyId, content });
  return id;
}

beforeAll(async () => {
  if (!available) return;
  await api.start();

  embedder = fakeAiEmbedder(768, { model: "fake-concepts", concepts: CONCEPTS });
  setAiEmbedder(embedder);

  authorId = await api.createUser("wrtr");
  readerId = await api.createUser("rdr");
  genreId = await api.createGenre("search-genre");

  // Shares no keyword with "mourning": not in its title, not in its author.
  const synonym = await api.createStory({
    title: "The Long Quiet",
    authorId,
    genreIds: [genreId],
  });
  ids.synonym = synonym.id;
  await chapterOf(synonym.id, 1, UNRELATED);
  await chapterOf(
    synonym.id,
    2,
    prose("After the funeral the house was full of casseroles and no one ate."),
  );

  // The best grief match in the corpus, and never listed.
  const draft = await api.createStory({
    title: "Unsent Letters",
    authorId,
    listed: false,
    genreIds: [genreId],
  });
  ids.draft = draft.id;
  await chapterOf(draft.id, 1, prose("Grief, grief, the whole of it was grief."));

  // Listed, but the only chapter about grief is unpublished. It was embedded
  // anyway -- a chapter can be embedded and then unpublished.
  const hidden = await api.createStory({
    title: "Second Drafts",
    authorId,
    genreIds: [genreId],
  });
  ids.hiddenChapterStory = hidden.id;
  await chapterOf(hidden.id, 1, UNRELATED);
  await chapterOf(
    hidden.id,
    2,
    prose("She was bereaved at nineteen and did not say so to anyone."),
    false,
  );

  // Hybrid fixtures. "Quillmoor" is in two titles; two chapters mean it.
  const both = await api.createStory({ title: "Quillmoor Tide", authorId });
  ids.both = both.id;
  await chapterOf(both.id, 1, prose("The lighthouse lamp turned all night."));

  const keywordOnly = await api.createStory({ title: "Quillmoor Ledger", authorId });
  ids.keywordOnly = keywordOnly.id;
  await chapterOf(keywordOnly.id, 1, UNRELATED);

  const meaningOnly = await api.createStory({ title: "The Keeper", authorId });
  ids.meaningOnly = meaningOnly.id;
  await chapterOf(meaningOnly.id, 1, prose("He climbed to the beacon every dusk."));

  const otherGenre = await api.createStory({ title: "Wake", authorId });
  ids.otherGenre = otherGenre.id;
  await chapterOf(otherGenre.id, 1, prose("The mourning lasted the winter."));
});

afterAll(async () => {
  if (!available) return;
  resetAiEmbedder();
  await api.stop();
});

beforeEach(async () => {
  if (!available) return;
  setAiEmbedder(embedder);
  embedder.reset();

  await connectRedis();
  for (const id of [authorId, readerId]) await redis.del(`ai:search:${id}`);
});

afterEach(() => {
  embedder?.reset();
});

interface Result {
  id: string;
  title: string;
  passages: { chapterId: string; chapterNumber: number; excerpt: string }[];
  match: {
    keywordRank: number | null;
    semanticRank: number | null;
    score: number;
  } | null;
}

async function searchAs(
  userId: string,
  params: Record<string, string>,
) {
  const query = new URLSearchParams(params).toString();
  return api.request<{
    items: Result[];
    total: number;
    basis: string;
    hasMore: boolean;
  }>(`/api/ai/search?${query}`, { as: userId });
}

const idsOf = (items: Result[]) => items.map((item) => item.id);

describe.skipIf(!available)("GET /api/ai/search", () => {
  it("requires a signed-in caller", async () => {
    const response = await api.request("/api/ai/search?q=grief");
    expect(response.status).toBe(401);
  });

  it("rejects a query longer than a sentence", async () => {
    const response = await searchAs(readerId, { q: "x".repeat(QUERY_LIMIT + 1) });
    expect(response.status).toBe(400);
  });

  it("finds a story by meaning when it shares no keyword with the query", async () => {
    // Keyword search alone does not find it -- that is the premise.
    const keyword = await api.request<{ items: { id: string }[] }>(
      "/api/stories?search=mourning",
      { as: readerId },
    );
    expect(keyword.body.items.map((story) => story.id)).not.toContain(ids.synonym);

    const response = await searchAs(readerId, { q: "mourning" });

    expect(response.status).toBe(200);
    expect(response.body.basis).toBe("hybrid");

    const found = response.body.items.find((item) => item.id === ids.synonym);
    expect(found).toBeDefined();
    expect(found?.match).toMatchObject({ keywordRank: null });
    expect(found?.match?.semanticRank).not.toBeNull();

    // The passage is the chapter that matched, not the one that did not.
    expect(found?.passages).toHaveLength(1);
    expect(found?.passages[0]?.chapterNumber).toBe(2);
    expect(found?.passages[0]?.excerpt).toContain("funeral");
  });

  it("sends the embedder exactly the query, once", async () => {
    await searchAs(readerId, { q: `  mourning   ${api.runId}  ` });

    expect(embedder.calls).toHaveLength(1);
    expect(embedder.calls[0]?.texts).toEqual([`mourning ${api.runId}`]);
    expect(embedder.calls[0]?.feature).toBe("search.query");
  });

  it("answers a repeated query from the cache without embedding it again", async () => {
    const q = `funeral ${api.runId}`;

    const first = await searchAs(readerId, { q });
    expect(embedder.calls).toHaveLength(1);

    const second = await searchAs(readerId, { q, page: "1" });
    expect(embedder.calls).toHaveLength(1);
    expect(idsOf(second.body.items)).toEqual(idsOf(first.body.items));
  });

  describe("visibility", () => {
    it("never shows a stranger a draft, however well it matches", async () => {
      const response = await searchAs(readerId, { q: "grief" });

      expect(response.status).toBe(200);
      expect(idsOf(response.body.items)).not.toContain(ids.draft);
    });

    it("never quotes a stranger an unpublished chapter of a listed story", async () => {
      const response = await searchAs(readerId, { q: "bereaved" });

      // The story's only matching chapter is unpublished, so it has no reason
      // to appear at all -- and its passage must not appear under anything.
      expect(idsOf(response.body.items)).not.toContain(ids.hiddenChapterStory);
      for (const item of response.body.items) {
        for (const passage of item.passages) {
          expect(passage.excerpt).not.toContain("nineteen");
        }
      }
    });

    it("shows an author their own draft and unpublished chapter", async () => {
      const response = await searchAs(authorId, { q: "grief" });
      const found = idsOf(response.body.items);

      expect(found).toContain(ids.draft);
      expect(found).toContain(ids.hiddenChapterStory);

      const hidden = response.body.items.find(
        (item) => item.id === ids.hiddenChapterStory,
      );
      expect(hidden?.passages[0]?.chapterNumber).toBe(2);
    });
  });

  it("ranks a keyword-and-meaning match above either alone", async () => {
    const response = await searchAs(readerId, { q: "quillmoor" });
    const results = response.body.items;
    const found = idsOf(results);

    expect(found).toContain(ids.both);
    expect(found).toContain(ids.keywordOnly);
    expect(found).toContain(ids.meaningOnly);

    const position = (id: string) => found.indexOf(id);
    expect(position(ids.both)).toBeLessThan(position(ids.keywordOnly));
    expect(position(ids.both)).toBeLessThan(position(ids.meaningOnly));

    const byId = new Map(results.map((item) => [item.id, item.match]));
    expect(byId.get(ids.both)?.keywordRank).not.toBeNull();
    expect(byId.get(ids.both)?.semanticRank).not.toBeNull();
    expect(byId.get(ids.keywordOnly)?.semanticRank).toBeNull();
    expect(byId.get(ids.meaningOnly)?.keywordRank).toBeNull();

    // A keyword-only match quotes nothing: no passage is why it is here.
    expect(results.find((item) => item.id === ids.keywordOnly)?.passages).toEqual([]);
  });

  it("drops keyword matches in semantic mode", async () => {
    const response = await searchAs(readerId, { q: "quillmoor", mode: "semantic" });
    const found = idsOf(response.body.items);

    expect(response.body.basis).toBe("semantic");
    expect(found).toContain(ids.both);
    expect(found).toContain(ids.meaningOnly);
    expect(found).not.toContain(ids.keywordOnly);
  });

  it("applies the genre filter to semantic results", async () => {
    const response = await searchAs(readerId, { q: "mourning", genreId });
    const found = idsOf(response.body.items);

    expect(found).toContain(ids.synonym);
    expect(found).not.toContain(ids.otherGenre);
  });

  it("falls back to the existing list for an empty query, without a model call", async () => {
    const [search, list] = await Promise.all([
      searchAs(readerId, { q: "", genreId }),
      api.request<{ items: { id: string }[]; total: number }>(
        `/api/stories?genreId=${genreId}&sort=trending`,
        { as: readerId },
      ),
    ]);

    expect(search.status).toBe(200);
    expect(search.body.basis).toBe("list");
    expect(idsOf(search.body.items)).toEqual(list.body.items.map((story) => story.id));
    expect(search.body.total).toBe(list.body.total);
    expect(search.body.items.every((item) => item.passages.length === 0)).toBe(true);
    expect(embedder.calls).toHaveLength(0);
  });

  describe("when the embedder is down", () => {
    it("degrades hybrid search to keywords, and says so", async () => {
      embedder.failNext(HttpError.unavailable("The embedding server is not reachable."));

      const response = await searchAs(readerId, { q: `quillmoor ${api.runId}x` });

      expect(response.status).toBe(200);
      expect(response.body.basis).toBe("keyword");
      // Nothing has "quillmoor <runId>x" in its title, so: empty, not an error.
      expect(response.body.items).toEqual([]);
    });

    it("keeps the keyword half's results", async () => {
      embedder.failNext(HttpError.unavailable("The embedding server is not reachable."));

      const response = await searchAs(readerId, { q: `Quillmoor Ledger` });

      expect(response.body.basis).toBe("keyword");
      expect(idsOf(response.body.items)).toContain(ids.keywordOnly);
    });

    it("fails a semantic-only search with the provider's status", async () => {
      embedder.failNext(HttpError.unavailable("The embedding server is not reachable."));

      const response = await searchAs(readerId, {
        q: `beacon ${api.runId}`,
        mode: "semantic",
      });

      expect(response.status).toBe(503);
    });
  });
});
