/**
 * A reader's personal shelves.
 *
 * Every function takes the reader's id explicitly — the routes resolve it once
 * through `middleware/current-user.ts` — so nothing here reaches for ambient
 * request state, and a shelf can never be read or written for the wrong user.
 */

import { Temporal } from "temporal-polyfill";
import { db } from "../prisma/db.js";
import { HttpError } from "../lib/http-error.js";
import { getBook, getBooksByIds, type Book } from "./books.js";

export const READING_STATUSES = [
  "WANT_TO_READ",
  "READING",
  "FINISHED",
] as const;

export type ReadingStatus = (typeof READING_STATUSES)[number];

export interface LibraryEntry {
  id: string;
  status: ReadingStatus;
  addedAt: string;
  updatedAt: string;
  book: Book;
}

/** How many books sit on each shelf, for the tab counters. */
export type LibraryCounts = Record<ReadingStatus, number> & { ALL: number };

export interface LibraryQuery {
  status?: ReadingStatus | undefined;
  search?: string | undefined;
}

export interface LibraryView {
  items: LibraryEntry[];
  counts: LibraryCounts;
}

/** Timestamp columns decode to `Temporal.Instant`; the API speaks ISO strings. */
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();

  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

/** `now()` in the spelling the timestamp codec writes. */
function nowInstant(): Temporal.Instant {
  return Temporal.Now.instant();
}

/* Reads ------------------------------------------------------------------ */

async function countsFor(userId: string): Promise<LibraryCounts> {
  const rows = await db.orm.library.LibraryEntry.select("status")
    .where((entry) => entry.userId.eq(userId))
    .all();

  const counts: LibraryCounts = {
    WANT_TO_READ: 0,
    READING: 0,
    FINISHED: 0,
    ALL: rows.length,
  };

  for (const row of rows) {
    counts[row.status as ReadingStatus] += 1;
  }

  return counts;
}

/**
 * The reader's shelf, newest addition first, with each entry's book attached.
 *
 * `search` filters on the loaded page in memory rather than in SQL: a personal
 * library is a small, bounded set, and matching on the joined title and author
 * is worth more here than pushing the predicate down.
 */
export async function listLibrary(
  userId: string,
  query: LibraryQuery = {},
): Promise<LibraryView> {
  let collection = db.orm.library.LibraryEntry.where((entry) =>
    entry.userId.eq(userId),
  );

  if (query.status) {
    const status = query.status;
    collection = collection.where((entry) => entry.status.eq(status));
  }

  const rows = await collection
    .orderBy([(entry) => entry.addedAt.desc(), (entry) => entry.id.desc()])
    .all();

  // One query for every book on the shelf, not one per row.
  const booksById = await getBooksByIds(rows.map((row) => row.storyId));

  let items: LibraryEntry[] = rows
    .map((row) => {
      // A book removed from the catalogue under the reader's feet simply
      // drops out of the shelf rather than failing the whole request.
      const book = booksById.get(row.storyId);
      if (!book) return null;

      return {
        id: row.id,
        status: row.status as ReadingStatus,
        addedAt: toIso(row.addedAt),
        updatedAt: toIso(row.updatedAt),
        book,
      };
    })
    .filter((entry): entry is LibraryEntry => entry !== null);

  const term = query.search?.trim().toLowerCase();
  if (term) {
    items = items.filter(
      (entry) =>
        entry.book.title.toLowerCase().includes(term) ||
        entry.book.author.username.toLowerCase().includes(term) ||
        entry.book.genres.some((genre) => genre.name.toLowerCase().includes(term)),
    );
  }

  return { items, counts: await countsFor(userId) };
}

/**
 * The reader's status for a set of books, so catalogue listings can show an
 * "in your library" state without a second request per card.
 */
export async function statusesForBooks(
  userId: string,
  bookIds: string[],
): Promise<Record<string, ReadingStatus>> {
  if (bookIds.length === 0) return {};

  const rows = await db.orm.library.LibraryEntry.select("storyId", "status")
    .where((entry) => entry.userId.eq(userId))
    .where((entry) => entry.storyId.in(bookIds))
    .all();

  return Object.fromEntries(
    rows.map((row) => [row.storyId, row.status as ReadingStatus]),
  );
}

/* Writes ----------------------------------------------------------------- */

async function findEntry(userId: string, bookId: string) {
  return db.orm.library.LibraryEntry.where((entry) => entry.userId.eq(userId))
    .where((entry) => entry.storyId.eq(bookId))
    .first();
}

async function requireBook(bookId: string): Promise<void> {
  const book = await db.orm.content.Story.select("id")
    .where((story) => story.id.eq(bookId))
    .first();

  if (!book) throw HttpError.notFound("That book could not be found.");
}

export async function addToLibrary(
  userId: string,
  bookId: string,
  status: ReadingStatus,
): Promise<LibraryEntry> {
  await requireBook(bookId);

  if (await findEntry(userId, bookId)) {
    throw HttpError.conflict("That book is already in your library.");
  }

  let created;
  try {
    created = await db.orm.library.LibraryEntry.create({
      userId,
      storyId: bookId,
      status,
    });
  } catch (error) {
    // Two simultaneous adds: the unique index is the real arbiter, so report
    // the loser the same way the pre-check above would have.
    if (isUniqueViolation(error)) {
      throw HttpError.conflict("That book is already in your library.");
    }
    throw error;
  }

  return {
    id: created.id,
    status: created.status as ReadingStatus,
    addedAt: toIso(created.addedAt),
    updatedAt: toIso(created.updatedAt),
    book: await getBook(bookId),
  };
}

export async function setReadingStatus(
  userId: string,
  bookId: string,
  status: ReadingStatus,
): Promise<LibraryEntry> {
  const existing = await findEntry(userId, bookId);
  if (!existing) throw HttpError.notFound("That book is not in your library.");

  await db.orm.library.LibraryEntry.where((entry) => entry.id.eq(existing.id)).update({
    status,
    updatedAt: nowInstant(),
  });

  // Read the row back rather than trusting a mutation return shape: `update`
  // does not answer with rows on this client.
  const row = (await findEntry(userId, bookId)) ?? {
    ...existing,
    status,
    updatedAt: nowInstant(),
  };

  return {
    id: row.id,
    status: row.status as ReadingStatus,
    addedAt: toIso(row.addedAt),
    updatedAt: toIso(row.updatedAt),
    book: await getBook(bookId),
  };
}

export async function removeFromLibrary(
  userId: string,
  bookId: string,
): Promise<void> {
  const existing = await findEntry(userId, bookId);
  if (!existing) throw HttpError.notFound("That book is not in your library.");

  await db.orm.library.LibraryEntry.where((entry) => entry.id.eq(existing.id)).delete();
}

/** Postgres reports a unique-constraint breach as SQLSTATE 23505. */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  const candidate = error as { code?: unknown; sqlState?: unknown; cause?: unknown };
  if (candidate.code === "23505" || candidate.sqlState === "23505") return true;

  return candidate.cause !== undefined && isUniqueViolation(candidate.cause);
}
