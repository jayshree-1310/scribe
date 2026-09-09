/**
 * Reads over the book catalogue.
 *
 * A "book" is `content.Story` — the catalogue entity Scribe already has —
 * joined with its author and genres. Nothing here writes; the shelf side of
 * the feature lives in `library.ts`.
 */

import { or } from "@prisma/orm-postgres/orm-client";
import { db } from "../prisma/db.js";
import { HttpError } from "../lib/http-error.js";

/* Shapes returned to the client ---------------------------------------- */

export interface BookAuthor {
  id: string;
  username: string;
}

export interface BookGenre {
  id: string;
  name: string;
  /** Base hue the UI composes cover art and genre chips from. */
  hue: number;
}

export interface Book {
  id: string;
  title: string;
  description: string | null;
  coverUrl: string | null;
  isbn: string | null;
  publisher: string | null;
  publishedAt: string | null;
  pageCount: number | null;
  isCompleted: boolean;
  kidsAppropriate: boolean;
  viewCount: number;
  likeCount: number;
  ratingAverage: number | null;
  createdAt: string;
  updatedAt: string;
  author: BookAuthor;
  genres: BookGenre[];
}

export interface Page<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

export const BOOK_SORTS = [
  "recent",
  "trending",
  "popular",
  "top-rated",
  "title",
] as const;

export type BookSort = (typeof BOOK_SORTS)[number];

export interface BookQuery {
  search?: string | undefined;
  genreId?: string | undefined;
  /** `true` keeps only finished works, `false` only ongoing ones. */
  completed?: boolean | undefined;
  sort: BookSort;
  page: number;
  limit: number;
}

/* Row mapping ----------------------------------------------------------- */

/**
 * `ratingAverage` is a Postgres `numeric`, which the driver decodes to a
 * decimal string to avoid lying about precision. JSON consumers want a number.
 */
function toRating(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Timestamp columns decode to `Temporal.Instant`. Everything downstream of the
 * API speaks ISO-8601 strings, and `Instant.toString()` already emits one, so
 * normalise through the string rather than depending on the exact class.
 */
function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();

  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

interface StoryRow {
  id: string;
  title: string;
  description: string | null;
  coverUrl: string | null;
  isbn: string | null;
  publisher: string | null;
  publishedAt: unknown;
  pageCount: number | null;
  isCompleted: boolean;
  kidsAppropriate: boolean;
  viewCount: number;
  likeCount: number;
  ratingAverage: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  authorId: string;
}

function toBook(
  row: StoryRow,
  author: BookAuthor,
  genres: BookGenre[],
): Book {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    coverUrl: row.coverUrl,
    isbn: row.isbn,
    publisher: row.publisher,
    publishedAt: toIso(row.publishedAt),
    pageCount: row.pageCount,
    isCompleted: row.isCompleted,
    kidsAppropriate: row.kidsAppropriate,
    viewCount: row.viewCount,
    likeCount: row.likeCount,
    ratingAverage: toRating(row.ratingAverage),
    createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: toIso(row.updatedAt) ?? new Date(0).toISOString(),
    author,
    genres,
  };
}

/* Joins ----------------------------------------------------------------- */

/**
 * Loads authors and genres for a batch of stories in three queries rather than
 * per row. Genres go through the `StoryGenre` junction by hand: the ORM does
 * not yet emit the two-step join for many-to-many `include`.
 */
async function hydrate(rows: StoryRow[]): Promise<Book[]> {
  if (rows.length === 0) return [];

  const storyIds = rows.map((row) => row.id);
  const authorIds = [...new Set(rows.map((row) => row.authorId))];

  const [authors, links] = await Promise.all([
    db.orm.auth.User.select("id", "username")
      .where((user) => user.id.in(authorIds))
      .all(),
    db.orm.content.StoryGenre.where((link) => link.storyId.in(storyIds)).all(),
  ]);

  const genreIds = [...new Set(links.map((link) => link.genreId))];
  const genres =
    genreIds.length === 0
      ? []
      : await db.orm.content.Genre.select("id", "name", "hue")
          .where((genre) => genre.id.in(genreIds))
          .all();

  const authorById = new Map(authors.map((author) => [author.id, author]));
  const genreById = new Map(genres.map((genre) => [genre.id, genre]));

  const genresByStory = new Map<string, BookGenre[]>();
  for (const link of links) {
    const genre = genreById.get(link.genreId);
    if (!genre) continue;
    const bucket = genresByStory.get(link.storyId);
    if (bucket) bucket.push(genre);
    else genresByStory.set(link.storyId, [genre]);
  }

  for (const bucket of genresByStory.values()) {
    bucket.sort((a, b) => a.name.localeCompare(b.name));
  }

  return rows.map((row) =>
    toBook(
      row,
      authorById.get(row.authorId) ?? { id: row.authorId, username: "unknown" },
      genresByStory.get(row.id) ?? [],
    ),
  );
}

/* Filtering ------------------------------------------------------------- */

/**
 * Resolves a free-text term to the story ids reachable through it by author,
 * so the caller can OR that against a title match in one query. Returns an
 * empty list when no author matches, which the caller treats as "title only".
 */
async function authorIdsMatching(term: string): Promise<string[]> {
  const matches = await db.orm.auth.User.select("id")
    .where((user) => user.username.ilike(`%${term}%`))
    .limit(50)
    .all();

  return matches.map((match) => match.id);
}

/** Story ids carrying a given genre, via the junction table. */
async function storyIdsInGenre(genreId: string): Promise<string[]> {
  const links = await db.orm.content.StoryGenre.select("storyId")
    .where((link) => link.genreId.eq(genreId))
    .all();

  return links.map((link) => link.storyId);
}

/** Escapes the `LIKE` wildcards so a search for "100%" is a literal search. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

type StoryCollection = ReturnType<typeof storiesBase>;

function storiesBase() {
  return db.orm.content.Story.select(
    "id",
    "title",
    "description",
    "coverUrl",
    "isbn",
    "publisher",
    "publishedAt",
    "pageCount",
    "isCompleted",
    "kidsAppropriate",
    "viewCount",
    "likeCount",
    "ratingAverage",
    "createdAt",
    "updatedAt",
    "authorId",
  );
}

/**
 * Narrows a catalogue query down to the rows it should consider. Returns
 * `null` when the filters cannot match anything — an unknown genre — letting
 * callers skip the round trip entirely.
 */
async function applyFilters(
  collection: StoryCollection,
  query: Pick<BookQuery, "search" | "genreId" | "completed" | "sort">,
): Promise<StoryCollection | null> {
  let current = collection;

  if (query.genreId) {
    const ids = await storyIdsInGenre(query.genreId);
    if (ids.length === 0) return null;
    current = current.where((story) => story.id.in(ids));
  }

  if (query.completed !== undefined) {
    const completed = query.completed;
    current = current.where((story) => story.isCompleted.eq(completed));
  }

  // "Highest rated" means rated: an unranked book would otherwise sort to the
  // top, since Postgres orders NULLs first on a descending sort.
  if (query.sort === "top-rated") {
    current = current.where((story) => story.ratingAverage.isNotNull());
  }

  const term = query.search?.trim();
  if (term) {
    const escaped = escapeLike(term);
    const pattern = `%${escaped}%`;
    const authorIds = await authorIdsMatching(escaped);

    current = current.where((story) =>
      authorIds.length > 0
        ? or(story.title.ilike(pattern), story.authorId.in(authorIds))
        : story.title.ilike(pattern),
    );
  }

  return current;
}

function applySort(collection: StoryCollection, sort: BookSort) {
  switch (sort) {
    case "trending":
      return collection.orderBy([
        (story) => story.viewCount.desc(),
        (story) => story.id.desc(),
      ]);
    case "popular":
      return collection.orderBy([
        (story) => story.likeCount.desc(),
        (story) => story.id.desc(),
      ]);
    case "top-rated":
      return collection.orderBy([
        (story) => story.ratingAverage.desc(),
        (story) => story.id.desc(),
      ]);
    case "title":
      return collection.orderBy([
        (story) => story.title.asc(),
        (story) => story.id.asc(),
      ]);
    case "recent":
    default:
      return collection.orderBy([
        (story) => story.createdAt.desc(),
        (story) => story.id.desc(),
      ]);
  }
}

/* Queries --------------------------------------------------------------- */

export const MAX_PAGE_SIZE = 48;

function emptyPage(page: number, limit: number): Page<Book> {
  return { items: [], page, limit, total: 0, totalPages: 0, hasMore: false };
}

export async function listBooks(query: BookQuery): Promise<Page<Book>> {
  const filtered = await applyFilters(storiesBase(), query);
  if (filtered === null) return emptyPage(query.page, query.limit);

  // The count reuses the same filtered collection, so `total` and `items`
  // can never disagree about what matched.
  const totals = await filtered.aggregate((aggregate) => ({
    total: aggregate.count(),
  }));

  const rows = await applySort(filtered, query.sort)
    .offset((query.page - 1) * query.limit)
    .limit(query.limit)
    .all();

  const items = await hydrate(rows as StoryRow[]);
  const total = totals.total;

  return {
    items,
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.ceil(total / query.limit),
    hasMore: query.page * query.limit < total,
  };
}

export async function getBook(id: string): Promise<Book> {
  const row = await storiesBase().where((story) => story.id.eq(id)).first();
  if (!row) throw HttpError.notFound("That book could not be found.");

  const [book] = await hydrate([row as StoryRow]);
  if (!book) throw HttpError.notFound("That book could not be found.");

  return book;
}

/**
 * Several books at once, keyed by id, in one round trip.
 *
 * The shelf reads a whole page of books this way rather than calling `getBook`
 * per row, which would be a query per entry plus three more to join each one.
 * Ids with no surviving book are simply absent from the map.
 */
export async function getBooksByIds(ids: string[]): Promise<Map<string, Book>> {
  if (ids.length === 0) return new Map();

  const rows = await storiesBase()
    .where((story) => story.id.in([...new Set(ids)]))
    .all();

  const items = await hydrate(rows as StoryRow[]);
  return new Map(items.map((book) => [book.id, book]));
}

/**
 * Books sharing a genre with `id`, best-rated first. Falls back to nothing
 * rather than to unrelated books: an empty "related" rail reads better than a
 * misleading one.
 */
export async function getRelatedBooks(id: string, limit = 6): Promise<Book[]> {
  const links = await db.orm.content.StoryGenre.select("genreId")
    .where((link) => link.storyId.eq(id))
    .all();

  if (links.length === 0) return [];

  const genreIds = links.map((link) => link.genreId);
  const siblings = await db.orm.content.StoryGenre.select("storyId")
    .where((link) => link.genreId.in(genreIds))
    .all();

  const candidateIds = [
    ...new Set(siblings.map((link) => link.storyId)),
  ].filter((storyId) => storyId !== id);

  if (candidateIds.length === 0) return [];

  const rows = await storiesBase()
    .where((story) => story.id.in(candidateIds))
    .orderBy([(story) => story.viewCount.desc(), (story) => story.id.desc()])
    .limit(limit)
    .all();

  return hydrate(rows as StoryRow[]);
}

export interface GenreSummary extends BookGenre {
  bookCount: number;
}

export async function listGenres(): Promise<GenreSummary[]> {
  const [genres, links] = await Promise.all([
    db.orm.content.Genre.select("id", "name", "hue")
      .orderBy((genre) => genre.name.asc())
      .all(),
    db.orm.content.StoryGenre.select("genreId").all(),
  ]);

  const counts = new Map<string, number>();
  for (const link of links) {
    counts.set(link.genreId, (counts.get(link.genreId) ?? 0) + 1);
  }

  return genres.map((genre) => ({
    ...genre,
    bookCount: counts.get(genre.id) ?? 0,
  }));
}

/* Discover rails --------------------------------------------------------- */

export interface DiscoverSection {
  genre: BookGenre;
  books: Book[];
}

export interface Discover {
  featured: Book | null;
  trending: Book[];
  recommended: Book[];
  sections: DiscoverSection[];
}

async function topBooks(sort: BookSort, limit: number): Promise<Book[]> {
  const filtered = await applyFilters(storiesBase(), {
    sort,
    search: undefined,
    genreId: undefined,
    completed: undefined,
  });
  if (filtered === null) return [];

  const rows = await applySort(filtered, sort).limit(limit).all();
  return hydrate(rows as StoryRow[]);
}

/**
 * Everything the Discover page opens with, in one round trip: a featured book,
 * two rails, and a shelf per genre.
 */
export async function getDiscover(genreSectionCount = 4): Promise<Discover> {
  const [trending, recommended, genres] = await Promise.all([
    topBooks("trending", 8),
    topBooks("top-rated", 8),
    listGenres(),
  ]);

  const featured = trending[0] ?? null;

  const busiest = genres
    .filter((genre) => genre.bookCount > 0)
    .sort((a, b) => b.bookCount - a.bookCount)
    .slice(0, genreSectionCount);

  const sections = await Promise.all(
    busiest.map(async (genre) => {
      const filtered = await applyFilters(storiesBase(), {
        sort: "trending",
        genreId: genre.id,
        search: undefined,
        completed: undefined,
      });
      if (filtered === null) return { genre, books: [] };

      const rows = await applySort(filtered, "trending").limit(6).all();
      return {
        genre: { id: genre.id, name: genre.name, hue: genre.hue },
        books: await hydrate(rows as StoryRow[]),
      };
    }),
  );

  return {
    featured,
    // The featured book leads the page; don't repeat it immediately below.
    trending: trending.filter((book) => book.id !== featured?.id),
    recommended,
    sections: sections.filter((section) => section.books.length > 0),
  };
}
