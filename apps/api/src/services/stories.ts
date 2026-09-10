/**
 * Reads over authored stories and their chapters.
 *
 * Scribe has one work entity, `content.Story`. This module serves the half a
 * member writes -- serialised, chaptered, addressed by slug -- while
 * `services/books.ts` serves imported catalogue editions over the same table.
 * `Story.source` is what separates them; see `docs/content-model.md`.
 *
 * Nothing here writes: the author-side mutations live in
 * `services/authoring.ts`, which delegates its reads back to this module.
 */

import { or } from "@prisma/orm-postgres/orm-client";
import { db } from "../prisma/db.js";
import { HttpError } from "../lib/http-error.js";

/* Shapes returned to the client ----------------------------------------- */

export interface StoryAuthor {
  id: string;
  username: string;
  /** Absent for password signups, where the UI falls back to the username. */
  displayName: string | null;
  avatarUrl: string | null;
}

export interface StoryGenre {
  id: string;
  name: string;
  /** Base hue the UI composes cover art and genre chips from. */
  hue: number;
}

/**
 * Derived, never stored: a story is a draft until it is listed, and complete
 * when its author says so. There is no "hiatus" -- the contract has no column
 * that could express one.
 */
export type StoryStatus = "draft" | "ongoing" | "completed";

export type StorySource = "SCRIBE" | "CATALOGUE";

export interface Story {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  coverUrl: string | null;
  source: StorySource;
  status: StoryStatus;
  isCompleted: boolean;
  kidsAppropriate: boolean;
  viewCount: number;
  likeCount: number;
  ratingAverage: number | null;
  ratingCount: number;
  /** Chapters the caller may read, not chapters that exist. */
  chapterCount: number;
  /** Summed over those same chapters. */
  wordCount: number;
  /** When the story became visible on Scribe; null means draft. */
  listedAt: string | null;
  /** The edition's own publication date, for catalogue imports. */
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  author: StoryAuthor;
  genres: StoryGenre[];
}

export interface ChapterSummary {
  id: string;
  storyId: string;
  number: number;
  title: string;
  wordCount: number;
  publishedAt: string | null;
}

export interface ChapterMedia {
  id: string;
  type: "IMAGE" | "AUDIO" | "VIDEO" | "LINK";
  url: string;
  displayOrder: number;
}

export interface Chapter extends ChapterSummary {
  content: string;
  multimedia: ChapterMedia[];
  /** Neighbouring chapter numbers the caller may read, or null at the edges. */
  previousNumber: number | null;
  nextNumber: number | null;
}

export interface Page<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

export const STORY_SORTS = ["trending", "newest", "rating", "views"] as const;

export type StorySort = (typeof STORY_SORTS)[number];

export interface StoryQuery {
  search?: string | undefined;
  genreId?: string | undefined;
  /**
   * One author's stories. Combined with the caller's own identity this is also
   * "my stories": the visibility rule already shows a caller their own drafts,
   * so an author asking for their own id gets drafts and everyone else asking
   * for it does not.
   */
  authorId?: string | undefined;
  sort: StorySort;
  page: number;
  limit: number;
}

export const MAX_PAGE_SIZE = 48;

/* Scalar normalisation --------------------------------------------------- */

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
export function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();

  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/* Row mapping ------------------------------------------------------------ */

interface StoryRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  coverUrl: string | null;
  source: string;
  isCompleted: boolean;
  kidsAppropriate: boolean;
  viewCount: number;
  likeCount: number;
  ratingAverage: unknown;
  listedAt: unknown;
  publishedAt: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  authorId: string;
}

/** Per-story aggregates, gathered in one pass over each child table. */
interface StoryTotals {
  chapterCount: number;
  wordCount: number;
  ratingCount: number;
  ratingAverage: number | null;
}

function statusOf(row: StoryRow): StoryStatus {
  if (row.listedAt === null || row.listedAt === undefined) return "draft";
  return row.isCompleted ? "completed" : "ongoing";
}

function toStory(
  row: StoryRow,
  author: StoryAuthor,
  genres: StoryGenre[],
  totals: StoryTotals,
): Story {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    coverUrl: row.coverUrl,
    source: row.source === "CATALOGUE" ? "CATALOGUE" : "SCRIBE",
    status: statusOf(row),
    isCompleted: row.isCompleted,
    kidsAppropriate: row.kidsAppropriate,
    viewCount: row.viewCount,
    likeCount: row.likeCount,
    // Ratings written since Task 3 win over the denormalised column, which
    // only carries a value for seeded catalogue editions.
    ratingAverage: totals.ratingCount > 0
      ? totals.ratingAverage
      : toRating(row.ratingAverage),
    ratingCount: totals.ratingCount,
    chapterCount: totals.chapterCount,
    wordCount: totals.wordCount,
    listedAt: toIso(row.listedAt),
    publishedAt: toIso(row.publishedAt),
    createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: toIso(row.updatedAt) ?? new Date(0).toISOString(),
    author,
    genres,
  };
}

const NO_TOTALS: StoryTotals = {
  chapterCount: 0,
  wordCount: 0,
  ratingCount: 0,
  ratingAverage: null,
};

/* Joins ------------------------------------------------------------------ */

function storiesBase() {
  return db.orm.content.Story.select(
    "id",
    "slug",
    "title",
    "description",
    "coverUrl",
    "source",
    "isCompleted",
    "kidsAppropriate",
    "viewCount",
    "likeCount",
    "ratingAverage",
    "listedAt",
    "publishedAt",
    "createdAt",
    "updatedAt",
    "authorId",
  );
}

type StoryCollection = ReturnType<typeof storiesBase>;

/**
 * Loads authors, genres and per-story totals for a batch of stories in a fixed
 * number of queries rather than a query per row. Genres go through the
 * `StoryGenre` junction by hand: the ORM does not yet emit the two-step join
 * for a many-to-many `include`.
 *
 * `viewerId` decides which chapters count toward the totals -- an author sees
 * their unpublished chapters reflected in the count, nobody else does.
 */
async function hydrate(
  rows: StoryRow[],
  viewerId: string | null,
): Promise<Story[]> {
  if (rows.length === 0) return [];

  const storyIds = rows.map((row) => row.id);
  const authorIds = [...new Set(rows.map((row) => row.authorId))];

  const [authors, links, chapters, ratings] = await Promise.all([
    db.orm.auth.User.select("id", "username", "displayName", "avatarUrl")
      .where((user) => user.id.in(authorIds))
      .all(),
    db.orm.content.StoryGenre.where((link) => link.storyId.in(storyIds)).all(),
    chapterTotals(rows, viewerId),
    ratingTotals(storyIds),
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

  const genresByStory = new Map<string, StoryGenre[]>();
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
    toStory(
      row,
      authorById.get(row.authorId) ?? {
        id: row.authorId,
        username: "unknown",
        displayName: null,
        avatarUrl: null,
      },
      genresByStory.get(row.id) ?? [],
      {
        ...NO_TOTALS,
        ...chapters.get(row.id),
        ...ratings.get(row.id),
      },
    ),
  );
}

/**
 * Chapter counts and summed word counts, keyed by story.
 *
 * Split by whether the caller authored the story, because the two groups count
 * different chapters: one query for the caller's own stories (all chapters),
 * one for everyone else's (published only).
 */
async function chapterTotals(
  rows: StoryRow[],
  viewerId: string | null,
): Promise<Map<string, Pick<StoryTotals, "chapterCount" | "wordCount">>> {
  const own = viewerId === null
    ? []
    : rows.filter((row) => row.authorId === viewerId).map((row) => row.id);
  const others = rows
    .filter((row) => !own.includes(row.id))
    .map((row) => row.id);

  const totals = new Map<
    string,
    Pick<StoryTotals, "chapterCount" | "wordCount">
  >();

  const groups = await Promise.all([
    own.length === 0
      ? []
      : db.orm.content.Chapter.where((chapter) => chapter.storyId.in(own))
          .groupBy("storyId")
          .aggregate((aggregate) => ({
            chapters: aggregate.count(),
            words: aggregate.sum("wordCount"),
          })),
    others.length === 0
      ? []
      : db.orm.content.Chapter.where((chapter) =>
          chapter.storyId.in(others),
        )
          .where((chapter) => chapter.publishedAt.isNotNull())
          .groupBy("storyId")
          .aggregate((aggregate) => ({
            chapters: aggregate.count(),
            words: aggregate.sum("wordCount"),
          })),
  ]);

  for (const group of groups.flat()) {
    totals.set(group.storyId, {
      chapterCount: group.chapters,
      wordCount: group.words ?? 0,
    });
  }

  return totals;
}

/** Rating counts and averages computed from `engagement.Rating` rows. */
async function ratingTotals(
  storyIds: string[],
): Promise<Map<string, Pick<StoryTotals, "ratingCount" | "ratingAverage">>> {
  const groups = await db.orm.engagement.Rating.where((rating) =>
    rating.storyId.in(storyIds),
  )
    .groupBy("storyId")
    .aggregate((aggregate) => ({
      count: aggregate.count(),
      average: aggregate.avgDecimal("rating"),
    }));

  return new Map(
    groups.map((group) => [
      group.storyId,
      { ratingCount: group.count, ratingAverage: toRating(group.average) },
    ]),
  );
}

/* Visibility ------------------------------------------------------------- */

/**
 * Restricts a query to stories the caller is allowed to see: anything listed,
 * plus their own drafts.
 *
 * Every read path routes through this. A draft is invisible even to a caller
 * who knows its slug, which is why the detail lookup applies the same filter
 * rather than checking ownership after the fact.
 */
function visibleTo(
  collection: StoryCollection,
  viewerId: string | null,
): StoryCollection {
  if (viewerId === null) {
    return collection.where((story) => story.listedAt.isNotNull());
  }

  return collection.where((story) =>
    or(story.listedAt.isNotNull(), story.authorId.eq(viewerId)),
  );
}

/* Filtering -------------------------------------------------------------- */

/** Escapes the `LIKE` wildcards so a search for "100%" is a literal search. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Resolves a free-text term to the author ids reachable through it, so the
 * caller can OR that against a title match in one query.
 */
async function authorIdsMatching(term: string): Promise<string[]> {
  const matches = await db.orm.auth.User.select("id")
    .where((user) =>
      or(
        user.username.ilike(`%${term}%`),
        user.displayName.ilike(`%${term}%`),
      ),
    )
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

/**
 * Narrows a discover query to the rows it should consider. Returns `null` when
 * the filters cannot match anything -- an unknown genre -- letting callers skip
 * the round trip entirely.
 */
async function applyFilters(
  collection: StoryCollection,
  query: Pick<StoryQuery, "search" | "genreId" | "authorId" | "sort">,
): Promise<StoryCollection | null> {
  // Authored stories only: catalogue imports are browsed through /api/books.
  let current = collection.where((story) => story.source.eq("SCRIBE"));

  if (query.authorId) {
    const authorId = query.authorId;
    current = current.where((story) => story.authorId.eq(authorId));
  }

  if (query.genreId) {
    const ids = await storyIdsInGenre(query.genreId);
    if (ids.length === 0) return null;
    current = current.where((story) => story.id.in(ids));
  }

  // "Highest rated" means rated: an unrated story would otherwise sort to the
  // top, since Postgres orders NULLs first on a descending sort.
  if (query.sort === "rating") {
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

/**
 * `id` is the tie-breaker on every sort so pagination is stable: without it,
 * two stories with equal view counts can swap places between page 1 and 2 and
 * a reader sees one twice.
 */
function applySort(collection: StoryCollection, sort: StorySort) {
  switch (sort) {
    // No view *events* exist yet -- `viewCount` is a lifetime total with no
    // time dimension to decay, so "trending" leans on engagement rather than
    // raw traffic. Revisit once story views are recorded per day.
    case "trending":
      return collection.orderBy([
        (story) => story.likeCount.desc(),
        (story) => story.viewCount.desc(),
        (story) => story.id.desc(),
      ]);
    case "views":
      return collection.orderBy([
        (story) => story.viewCount.desc(),
        (story) => story.id.desc(),
      ]);
    case "rating":
      return collection.orderBy([
        (story) => story.ratingAverage.desc(),
        (story) => story.id.desc(),
      ]);
    // Postgres sorts NULLs first on a descending order, so a caller's own
    // drafts -- the only rows with a null `listedAt` -- lead this sort rather
    // than trailing it. Harmless while drafts are visible to their author
    // alone, but it is the reason this is not the default sort.
    case "newest":
    default:
      return collection.orderBy([
        (story) => story.listedAt.desc(),
        (story) => story.id.desc(),
      ]);
  }
}

/* Queries ---------------------------------------------------------------- */

function emptyPage(page: number, limit: number): Page<Story> {
  return { items: [], page, limit, total: 0, totalPages: 0, hasMore: false };
}

export async function listStories(
  query: StoryQuery,
  viewerId: string | null,
): Promise<Page<Story>> {
  const filtered = await applyFilters(
    visibleTo(storiesBase(), viewerId),
    query,
  );
  if (filtered === null) return emptyPage(query.page, query.limit);

  // The count reuses the same filtered collection, so `total` and `items` can
  // never disagree about what matched.
  const totals = await filtered.aggregate((aggregate) => ({
    total: aggregate.count(),
  }));

  const rows = await applySort(filtered, query.sort)
    .offset((query.page - 1) * query.limit)
    .limit(query.limit)
    .all();

  const items = await hydrate(rows as StoryRow[], viewerId);
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

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One story by slug or by id.
 *
 * Both work because the app addresses stories by slug but links minted before
 * slugs existed -- and everything the API itself returns -- carry ids. The id
 * branch is only attempted for something shaped like a UUID: comparing an
 * arbitrary string against a `uuid` column is a Postgres error, not a miss.
 */
async function findStoryRow(
  slugOrId: string,
  viewerId: string | null,
): Promise<StoryRow | null> {
  const visible = visibleTo(storiesBase(), viewerId);

  const row = await visible.where((story) => story.slug.eq(slugOrId)).first();
  if (row) return row as StoryRow;

  if (!UUID.test(slugOrId)) return null;

  const byId = await visible.where((story) => story.id.eq(slugOrId)).first();
  return (byId as StoryRow | undefined) ?? null;
}

const NOT_FOUND = "That story could not be found.";

export async function getStory(
  slugOrId: string,
  viewerId: string | null,
): Promise<Story> {
  const row = await findStoryRow(slugOrId, viewerId);
  if (!row) throw HttpError.notFound(NOT_FOUND);

  const [story] = await hydrate([row], viewerId);
  if (!story) throw HttpError.notFound(NOT_FOUND);

  return story;
}

/** Chapters of one story, in reading order, without their bodies. */
export async function listChapters(
  slugOrId: string,
  viewerId: string | null,
): Promise<ChapterSummary[]> {
  const story = await findStoryRow(slugOrId, viewerId);
  if (!story) throw HttpError.notFound(NOT_FOUND);

  const rows = await chaptersVisibleTo(story, viewerId)
    .select("id", "storyId", "chapterNumber", "title", "wordCount", "publishedAt")
    .orderBy((chapter) => chapter.chapterNumber.asc())
    .all();

  return rows.map((row) => ({
    id: row.id,
    storyId: row.storyId,
    number: row.chapterNumber,
    title: row.title,
    wordCount: row.wordCount,
    publishedAt: toIso(row.publishedAt),
  }));
}

/**
 * An unpublished chapter is visible to its author and to nobody else, so an
 * author previewing a draft reads it through the same endpoint the audience
 * will use.
 */
function chaptersVisibleTo(story: StoryRow, viewerId: string | null) {
  const chapters = db.orm.content.Chapter.where((chapter) =>
    chapter.storyId.eq(story.id),
  );

  return story.authorId === viewerId
    ? chapters
    : chapters.where((chapter) => chapter.publishedAt.isNotNull());
}

export async function getChapter(
  slugOrId: string,
  number: number,
  viewerId: string | null,
): Promise<Chapter> {
  const story = await findStoryRow(slugOrId, viewerId);
  if (!story) throw HttpError.notFound(NOT_FOUND);

  const visible = chaptersVisibleTo(story, viewerId);

  const row = await visible
    .select(
      "id",
      "storyId",
      "chapterNumber",
      "title",
      "content",
      "wordCount",
      "publishedAt",
    )
    .where((chapter) => chapter.chapterNumber.eq(number))
    .first();

  if (!row) throw HttpError.notFound("That chapter could not be found.");

  /**
   * The reader's prev/next links must skip a gap rather than dead-end on it,
   * so the neighbours are the nearest visible numbers either side -- not
   * `number ± 1`, which would break on an unpublished chapter in the middle
   * or after a deletion left the sequence uneven.
   */
  const [previous, next, media] = await Promise.all([
    visible
      .select("chapterNumber")
      .where((chapter) => chapter.chapterNumber.lt(number))
      .orderBy((chapter) => chapter.chapterNumber.desc())
      .first(),
    visible
      .select("chapterNumber")
      .where((chapter) => chapter.chapterNumber.gt(number))
      .orderBy((chapter) => chapter.chapterNumber.asc())
      .first(),
    db.orm.content.Multimedia.select("id", "type", "url", "displayOrder")
      .where((item) => item.chapterId.eq(row.id))
      .orderBy([
        (item) => item.displayOrder.asc(),
        (item) => item.id.asc(),
      ])
      .all(),
  ]);

  return {
    id: row.id,
    storyId: row.storyId,
    number: row.chapterNumber,
    title: row.title,
    content: row.content,
    wordCount: row.wordCount,
    publishedAt: toIso(row.publishedAt),
    multimedia: media.map((item) => ({
      id: item.id,
      type: item.type as ChapterMedia["type"],
      url: item.url,
      displayOrder: item.displayOrder,
    })),
    previousNumber: previous?.chapterNumber ?? null,
    nextNumber: next?.chapterNumber ?? null,
  };
}

/**
 * Stories sharing a genre with this one, most engaged first. Returns nothing
 * rather than falling back to unrelated stories: an empty "related" rail reads
 * better than a misleading one.
 */
export async function getRelatedStories(
  slugOrId: string,
  viewerId: string | null,
  limit = 6,
): Promise<Story[]> {
  const story = await findStoryRow(slugOrId, viewerId);
  if (!story) throw HttpError.notFound(NOT_FOUND);

  const links = await db.orm.content.StoryGenre.select("genreId")
    .where((link) => link.storyId.eq(story.id))
    .all();

  if (links.length === 0) return [];

  const genreIds = links.map((link) => link.genreId);
  const siblings = await db.orm.content.StoryGenre.select("storyId")
    .where((link) => link.genreId.in(genreIds))
    .all();

  const candidateIds = [...new Set(siblings.map((link) => link.storyId))].filter(
    (storyId) => storyId !== story.id,
  );

  if (candidateIds.length === 0) return [];

  // Drafts are excluded even for their own author here: this rail is a
  // recommendation to a reader, not a view of the caller's own shelf.
  const rows = await storiesBase()
    .where((candidate) => candidate.id.in(candidateIds))
    .where((candidate) => candidate.listedAt.isNotNull())
    .where((candidate) => candidate.source.eq("SCRIBE"))
    .orderBy([
      (candidate) => candidate.likeCount.desc(),
      (candidate) => candidate.id.desc(),
    ])
    .limit(limit)
    .all();

  return hydrate(rows as StoryRow[], viewerId);
}

/* Reference data --------------------------------------------------------- */

export interface GenreSummary extends StoryGenre {
  storyCount: number;
}

/**
 * Every genre, with the number of listed stories carrying it.
 *
 * The count deliberately ignores drafts and catalogue imports, so it matches
 * what a reader finds after clicking the chip.
 */
export async function listGenres(): Promise<GenreSummary[]> {
  const [genres, links, listed] = await Promise.all([
    db.orm.content.Genre.select("id", "name", "hue")
      .orderBy((genre) => genre.name.asc())
      .all(),
    db.orm.content.StoryGenre.select("storyId", "genreId").all(),
    db.orm.content.Story.select("id")
      .where((story) => story.listedAt.isNotNull())
      .where((story) => story.source.eq("SCRIBE"))
      .all(),
  ]);

  const listedIds = new Set(listed.map((story) => story.id));

  const counts = new Map<string, number>();
  for (const link of links) {
    if (!listedIds.has(link.storyId)) continue;
    counts.set(link.genreId, (counts.get(link.genreId) ?? 0) + 1);
  }

  return genres.map((genre) => ({
    ...genre,
    storyCount: counts.get(genre.id) ?? 0,
  }));
}
