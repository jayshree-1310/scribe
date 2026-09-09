import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestApi, databaseAvailable } from "../test/harness.js";

const api = new TestApi();
const available = await databaseAvailable();

let reader: string;
let otherReader: string;
let bookId: string;
let secondBookId: string;

/** Puts `bookId` on `reader`'s shelf and returns the created entry. */
async function addBook(status?: string, book = bookId, as = reader) {
  const response = await api.request("/api/library", {
    method: "POST",
    as,
    body: status === undefined ? { bookId: book } : { bookId: book, status },
  });

  if (response.body?.entry?.id) api.track(response.body.entry.id);
  return response;
}

beforeAll(async () => {
  if (!available) return;
  await api.start();

  const authorId = await api.createUser("author");
  const genreId = await api.createGenre("Shelving");

  reader = await api.createUser("reader");
  otherReader = await api.createUser("nosy");

  bookId = await api.createBook({
    title: "The Reader's Own Copy",
    authorId,
    genreIds: [genreId],
  });
  secondBookId = await api.createBook({
    title: "A Second Volume",
    authorId,
    genreIds: [genreId],
  });
}, 30_000);

afterAll(async () => {
  if (available) await api.stop();
});

describe.skipIf(!available)("authorisation", () => {
  it("401s on every library route without a reader", async () => {
    const responses = await Promise.all([
      api.request("/api/library"),
      api.request("/api/library", { method: "POST", body: { bookId } }),
      api.request(`/api/library/${bookId}`, {
        method: "PATCH",
        body: { status: "READING" },
      }),
      api.request(`/api/library/${bookId}`, { method: "DELETE" }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("unauthorized");
    }
  });

  it("never shows one reader another reader's shelf", async () => {
    await addBook("READING");

    const mine = await api.request("/api/library", { as: reader });
    const theirs = await api.request("/api/library", { as: otherReader });

    expect(mine.body.items).toHaveLength(1);
    expect(theirs.body.items).toHaveLength(0);
    expect(theirs.body.counts.ALL).toBe(0);

    await api.request(`/api/library/${bookId}`, { method: "DELETE", as: reader });
  });

  it("will not let one reader change another reader's entry", async () => {
    await addBook("READING");

    const patch = await api.request(`/api/library/${bookId}`, {
      method: "PATCH",
      as: otherReader,
      body: { status: "FINISHED" },
    });
    const remove = await api.request(`/api/library/${bookId}`, {
      method: "DELETE",
      as: otherReader,
    });

    expect(patch.status).toBe(404);
    expect(remove.status).toBe(404);

    // The owner's entry is untouched.
    const mine = await api.request("/api/library", { as: reader });
    expect(mine.body.items[0].status).toBe("READING");

    await api.request(`/api/library/${bookId}`, { method: "DELETE", as: reader });
  });
});

describe.skipIf(!available)("POST /api/library", () => {
  it("adds a book, defaulting to Want to read", async () => {
    const { status, body } = await addBook();

    expect(status).toBe(201);
    expect(body.entry.status).toBe("WANT_TO_READ");
    expect(body.entry.book.id).toBe(bookId);
    expect(body.entry.addedAt).toBeTruthy();

    await api.request(`/api/library/${bookId}`, { method: "DELETE", as: reader });
  });

  it("accepts an explicit status", async () => {
    const { body } = await addBook("FINISHED");
    expect(body.entry.status).toBe("FINISHED");

    await api.request(`/api/library/${bookId}`, { method: "DELETE", as: reader });
  });

  it("409s rather than adding the same book twice", async () => {
    const first = await addBook();
    const second = await addBook();

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("conflict");

    const list = await api.request("/api/library", { as: reader });
    expect(list.body.items).toHaveLength(1);

    await api.request(`/api/library/${bookId}`, { method: "DELETE", as: reader });
  });

  it("404s for a book that does not exist", async () => {
    const { status, body } = await api.request("/api/library", {
      method: "POST",
      as: reader,
      body: { bookId: "11111111-1111-4111-8111-111111111111" },
    });

    expect(status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  it("400s on an unknown status", async () => {
    const { status, body } = await api.request("/api/library", {
      method: "POST",
      as: reader,
      body: { bookId, status: "ABANDONED" },
    });

    expect(status).toBe(400);
    expect(body.error.details).toHaveProperty("status");
  });
});

describe.skipIf(!available)("GET /api/library", () => {
  it("returns the shelf with per-status counts", async () => {
    await addBook("READING");
    await addBook("WANT_TO_READ", secondBookId);

    const { status, body } = await api.request("/api/library", { as: reader });

    expect(status).toBe(200);
    expect(body.items).toHaveLength(2);
    expect(body.counts).toMatchObject({
      READING: 1,
      WANT_TO_READ: 1,
      FINISHED: 0,
      ALL: 2,
    });
  });

  it("filters by reading status", async () => {
    const { body } = await api.request("/api/library?status=READING", {
      as: reader,
    });

    expect(body.items).toHaveLength(1);
    expect(body.items[0].book.id).toBe(bookId);
    // The counts stay whole-shelf so the tabs keep their numbers.
    expect(body.counts.ALL).toBe(2);
  });

  it("searches within the shelf", async () => {
    const { body } = await api.request("/api/library?search=Second", {
      as: reader,
    });

    expect(body.items).toHaveLength(1);
    expect(body.items[0].book.id).toBe(secondBookId);
  });

  it("returns an empty shelf rather than an error for a reader with nothing", async () => {
    const { status, body } = await api.request("/api/library", {
      as: otherReader,
    });

    expect(status).toBe(200);
    expect(body.items).toEqual([]);
    expect(body.counts.ALL).toBe(0);
  });
});

describe.skipIf(!available)("PATCH /api/library/:bookId", () => {
  it("changes the reading status", async () => {
    const { status, body } = await api.request(`/api/library/${bookId}`, {
      method: "PATCH",
      as: reader,
      body: { status: "FINISHED" },
    });

    expect(status).toBe(200);
    expect(body.entry.status).toBe("FINISHED");

    const list = await api.request("/api/library?status=FINISHED", { as: reader });
    expect(list.body.items.map((item: { book: { id: string } }) => item.book.id)).toEqual([
      bookId,
    ]);
  });

  it("shows the new status on the catalogue entry too", async () => {
    const { body } = await api.request(`/api/books/${bookId}`, { as: reader });
    expect(body.book.libraryStatus).toBe("FINISHED");
  });

  it("404s for a book that is not on the shelf", async () => {
    const { status, body } = await api.request(
      "/api/library/11111111-1111-4111-8111-111111111111",
      { method: "PATCH", as: reader, body: { status: "READING" } },
    );

    expect(status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  it("400s on an unknown status", async () => {
    const { status } = await api.request(`/api/library/${bookId}`, {
      method: "PATCH",
      as: reader,
      body: { status: "SOMEDAY" },
    });

    expect(status).toBe(400);
  });
});

describe.skipIf(!available)("DELETE /api/library/:bookId", () => {
  it("removes the book from the shelf", async () => {
    const { status } = await api.request(`/api/library/${bookId}`, {
      method: "DELETE",
      as: reader,
    });

    expect(status).toBe(204);

    const list = await api.request("/api/library", { as: reader });
    expect(list.body.items.map((item: { book: { id: string } }) => item.book.id)).toEqual([
      secondBookId,
    ]);
  });

  it("leaves the book in the catalogue", async () => {
    const { status, body } = await api.request(`/api/books/${bookId}`);

    expect(status).toBe(200);
    expect(body.book.libraryStatus).toBeNull();
  });

  it("404s when the book was not on the shelf", async () => {
    const { status, body } = await api.request(`/api/library/${bookId}`, {
      method: "DELETE",
      as: reader,
    });

    expect(status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });
});
