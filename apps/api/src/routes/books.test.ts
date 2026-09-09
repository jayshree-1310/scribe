import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestApi, databaseAvailable } from "../test/harness.js";

const api = new TestApi();
const available = await databaseAvailable();

let authorId: string;
let otherAuthorId: string;
let genreId: string;
let otherGenreId: string;
let ids: Record<string, string> = {};

beforeAll(async () => {
  if (!available) return;
  await api.start();

  authorId = await api.createUser("novelist");
  otherAuthorId = await api.createUser("poet");
  genreId = await api.createGenre("Cartography", 268);
  otherGenreId = await api.createGenre("Marginalia", 32);

  ids = {
    atlas: await api.createBook({
      title: "An Atlas of Missing Coastlines",
      authorId,
      genreIds: [genreId],
      ratingAverage: 4.9,
      viewCount: 900,
      likeCount: 90,
      publisher: "Fixture & Sons",
      publishedAt: "2021-05-04",
      pageCount: 333,
    }),
    compass: await api.createBook({
      title: "The Broken Compass",
      authorId,
      genreIds: [genreId, otherGenreId],
      ratingAverage: 4.1,
      viewCount: 500,
      likeCount: 50,
    }),
    footnote: await api.createBook({
      title: "Footnotes for a Quiet Room",
      authorId: otherAuthorId,
      genreIds: [otherGenreId],
      ratingAverage: null,
      viewCount: 100,
      likeCount: 10,
      isCompleted: false,
    }),
  };
}, 30_000);

afterAll(async () => {
  if (available) await api.stop();
});

describe.skipIf(!available)("GET /api/books", () => {
  it("lists books with pagination metadata", async () => {
    const { status, body } = await api.request("/api/books?limit=2");

    expect(status).toBe(200);
    expect(body.items).toHaveLength(2);
    expect(body.limit).toBe(2);
    expect(body.page).toBe(1);
    expect(body.total).toBeGreaterThanOrEqual(3);
    expect(body.hasMore).toBe(true);
  });

  it("returns a second page that does not repeat the first", async () => {
    const first = await api.request("/api/books?limit=2&page=1");
    const second = await api.request("/api/books?limit=2&page=2");

    const firstIds = first.body.items.map((book: { id: string }) => book.id);
    const secondIds = second.body.items.map((book: { id: string }) => book.id);

    expect(second.body.page).toBe(2);
    expect(secondIds.some((id: string) => firstIds.includes(id))).toBe(false);
  });

  it("carries the joined author, genres and publication details", async () => {
    const { body } = await api.request(
      `/api/books?search=${encodeURIComponent("An Atlas of Missing Coastlines")}`,
    );

    const book = body.items[0];
    expect(book.title).toBe("An Atlas of Missing Coastlines");
    expect(book.author.id).toBe(authorId);
    expect(book.genres.map((genre: { id: string }) => genre.id)).toContain(genreId);
    expect(book.publisher).toBe("Fixture & Sons");
    expect(book.pageCount).toBe(333);
    expect(book.publishedAt).toContain("2021-05-04");
    // Decimals reach the client as numbers, not strings.
    expect(book.ratingAverage).toBe(4.9);
  });

  it("searches by title", async () => {
    const { body } = await api.request("/api/books?search=Broken%20Compass");

    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(ids["compass"]);
  });

  it("searches by author", async () => {
    const { body } = await api.request(
      `/api/books?search=${encodeURIComponent(api.runId)}-poet`,
    );

    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(ids["footnote"]);
  });

  it("treats a search with no match as an empty page, not an error", async () => {
    const { status, body } = await api.request(
      "/api/books?search=zzz-no-such-book-zzz",
    );

    expect(status).toBe(200);
    expect(body.items).toHaveLength(0);
    expect(body.total).toBe(0);
    expect(body.hasMore).toBe(false);
  });

  it("filters by genre", async () => {
    const { body } = await api.request(`/api/books?genreId=${otherGenreId}`);

    const returned = body.items.map((book: { id: string }) => book.id).sort();
    expect(returned).toEqual([ids["compass"], ids["footnote"]].sort());
  });

  it("filters by completion status", async () => {
    const { body } = await api.request(
      `/api/books?genreId=${otherGenreId}&status=ongoing`,
    );

    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(ids["footnote"]);
  });

  it("sorts by rating, leaving unrated books out of a 'highest rated' list", async () => {
    const { body } = await api.request(
      `/api/books?genreId=${otherGenreId}&sort=top-rated`,
    );

    expect(body.items.map((book: { id: string }) => book.id)).toEqual([
      ids["compass"],
    ]);
  });

  it("sorts by title", async () => {
    const { body } = await api.request(
      `/api/books?genreId=${genreId}&sort=title`,
    );

    expect(body.items.map((book: { title: string }) => book.title)).toEqual([
      "An Atlas of Missing Coastlines",
      "The Broken Compass",
    ]);
  });

  it("rejects a page size beyond the cap", async () => {
    const { status, body } = await api.request("/api/books?limit=500");

    expect(status).toBe(400);
    expect(body.error.code).toBe("validation_error");
    expect(body.error.details).toHaveProperty("limit");
  });

  it("rejects a non-numeric page", async () => {
    const { status, body } = await api.request("/api/books?page=abc");

    expect(status).toBe(400);
    expect(body.error.details).toHaveProperty("page");
  });

  it("reports no library status for an anonymous caller", async () => {
    const { body } = await api.request("/api/books?limit=1");
    expect(body.items[0].libraryStatus).toBeNull();
  });
});

describe.skipIf(!available)("GET /api/books/:id", () => {
  it("returns a single book", async () => {
    const { status, body } = await api.request(`/api/books/${ids["atlas"]}`);

    expect(status).toBe(200);
    expect(body.book.id).toBe(ids["atlas"]);
    expect(body.book.isbn).toBeTruthy();
    expect(body.book.author.id).toBe(authorId);
  });

  it("404s for a book that does not exist", async () => {
    const { status, body } = await api.request(
      "/api/books/11111111-1111-4111-8111-111111111111",
    );

    expect(status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  it("400s for an id that is not a uuid", async () => {
    const { status } = await api.request("/api/books/not-a-uuid");
    expect(status).toBe(400);
  });
});

describe.skipIf(!available)("GET /api/books/:id/related", () => {
  it("returns books sharing a genre, excluding the book itself", async () => {
    const { status, body } = await api.request(
      `/api/books/${ids["atlas"]}/related`,
    );

    expect(status).toBe(200);
    const returned = body.books.map((book: { id: string }) => book.id);
    expect(returned).toContain(ids["compass"]);
    expect(returned).not.toContain(ids["atlas"]);
  });
});

describe.skipIf(!available)("GET /api/books/genres", () => {
  it("lists genres with how many books carry each", async () => {
    const { status, body } = await api.request("/api/books/genres");

    expect(status).toBe(200);
    const genre = body.genres.find((item: { id: string }) => item.id === genreId);
    expect(genre.bookCount).toBe(2);
    expect(genre.hue).toBe(268);
  });
});

describe.skipIf(!available)("GET /api/books/discover", () => {
  it("returns a featured book, rails and genre sections", async () => {
    const { status, body } = await api.request("/api/books/discover");

    expect(status).toBe(200);
    expect(body.featured).not.toBeNull();
    expect(Array.isArray(body.trending)).toBe(true);
    expect(Array.isArray(body.recommended)).toBe(true);
    expect(Array.isArray(body.sections)).toBe(true);
    // The featured book leads the page and is not repeated in the rail below.
    expect(
      body.trending.some((book: { id: string }) => book.id === body.featured.id),
    ).toBe(false);
  });
});
