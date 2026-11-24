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
  /**
   * Whether readers may make quote cards from this story. The author's
   * choice, on unless they turn it off; the reader hides the action when
   * false.
   */
  quoteCards: boolean;
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
  /**
   * When an unpublished chapter is set to go live. Only ever set on a row
   * the caller can see unpublished, which is to say only for its author --
   * readers get the release through `StoryDetail.nextRelease` instead.
   */
  scheduledAt: string | null;
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
  /**
   * Readers who liked this chapter, and whether the caller is one of them.
   * On the detail shape and not on `ChapterSummary`: the chapter list would
   * need an aggregate per row to carry it, and nothing in a list draws it.
   */
  likeCount: number;
  /** False when anonymous, rather than a null every caller would branch on. */
  likedByMe: boolean;
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
  /** See `BookQuery.kidsAppropriate`: narrows to `true`, never away from it. */
  kidsAppropriate?: boolean | undefined;
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
  quoteCards: boolean;
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
    quoteCards: row.quoteCards,
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
    "quoteCards",
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
  betaStoryIds: ReadonlySet<string> = new Set(),
): Promise<Story[]> {
  if (rows.length === 0) return [];

  const storyIds = rows.map((row) => row.id);
  const authorIds = [...new Set(rows.map((row) => row.authorId))];

  const [authors, links, chapters, ratings] = await Promise.all([
    db.orm.auth.User.select("id", "username", "displayName", "avatarUrl")
      .where((user) => user.id.in(authorIds))
      .all(),
    db.orm.content.StoryGenre.where((link) => link.storyId.in(storyIds)).all(),
    chapterTotals(rows, viewerId, betaStoryIds),
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
 * Split by how the caller reads each story (`StoryAccess`), because the groups
 * count different chapters: the caller's own stories (all chapters), stories
 * they beta-read (all but taken-down ones), and everyone else's (published
 * only).
 */
async function chapterTotals(
  rows: StoryRow[],
  viewerId: string | null,
  betaStoryIds: ReadonlySet<string>,
): Promise<Map<string, Pick<StoryTotals, "chapterCount" | "wordCount">>> {
  const own = viewerId === null
    ? []
    : rows.filter((row) => row.authorId === viewerId).map((row) => row.id);
  const beta = rows
    .filter((row) => !own.includes(row.id) && betaStoryIds.has(row.id))
    .map((row) => row.id);
  const others = rows
    .filter((row) => !own.includes(row.id) && !beta.includes(row.id))
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
    beta.length === 0
      ? []
      : db.orm.content.Chapter.where((chapter) => chapter.storyId.in(beta))
          .where((chapter) => chapter.hiddenAt.isNull())
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
/**
 * Authors whose name matches `term`, by word rather than by phrase.
 *
 * Every word must appear somewhere in the username or the display name, in any
 * order. That is what makes all of these find `amara_okonkwo`:
 *
 *   "amara okonkwo"   "Okonkwo, Amara"   "Amara  Okonkwo"   "okonkwo"
 *
 * A single `ilike` over the whole phrase finds none of them but the last.
 * Catalogue authors are seeded with usernames like `amara_okonkwo` and no
 * display name, a space matches neither `_` nor `-`, and a name arrives
 * reordered and punctuated as often as not -- so phrase matching left every
 * catalogue author unsearchable by the only name a reader knows them by.
 *
 * Takes the **raw** term and escapes each word itself: escaping first would
 * make the separators it needs to ignore significant again.
 */
async function authorIdsMatching(term: string): Promise<string[]> {
  // Two characters minimum, so an initial or a stray "a" does not match every
  // author in the catalogue. Capped, so a pasted paragraph cannot build a
  // hundred-clause query.
  const words = term
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2)
    .slice(0, 5);

  if (words.length === 0) return [];

  let query = db.orm.auth.User.select("id");

  // Chained `where`s are ANDed: every word has to land somewhere in the name.
  for (const word of words) {
    const pattern = `%${escapeLike(word)}%`;
    query = query.where((user) =>
      or(user.username.ilike(pattern), user.displayName.ilike(pattern)),
    );
  }

  const matches = await query.limit(50).all();

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
  query: Pick<
    StoryQuery,
    "search" | "genreId" | "authorId" | "kidsAppropriate" | "sort"
  >,
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

  if (query.kidsAppropriate) {
    current = current.where((story) => story.kidsAppropriate.eq(true));
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
    const authorIds = await authorIdsMatching(term);

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
    // `viewCount` is a lifetime total with no time dimension to decay, so
    // "trending" leans on engagement rather than raw traffic. Per-day view
    // events now exist (`engagement.StoryView`, added with author analytics),
    // so a real recency window is finally expressible -- but it is a ranking
    // change with its own trade-offs, not a side effect of recording them.
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

/* Beta readers ----------------------------------------------------------- */

/**
 * How the caller reads one story, which decides the chapters they see:
 *
 * - `author`: every chapter, as before.
 * - `beta`: a reader the author let in through the story's invite link
 *   (`beta.Reader`, `services/beta.ts`). Every chapter a moderator has not
 *   taken down, published or not -- a draft story included.
 * - `reader`: published chapters of a listed story.
 *
 * Beta access is for *reading*. Comments, likes and ratings are public, so
 * the lookups behind them (`findVisibleStoryId`, `findVisibleChapter`) leave
 * beta readers out unless the caller opts in with `{ beta: true }` -- a
 * public comment on a draft would be published the day the draft is.
 */
export type StoryAccess = "author" | "beta" | "reader";

export interface BetaOption {
  /** Count the caller's beta access; see `StoryAccess`. */
  beta?: boolean;
}

async function isBetaReader(storyId: string, viewerId: string): Promise<boolean> {
  const row = await db.orm.beta.Reader.select("userId")
    .where((reader) => reader.storyId.eq(storyId))
    .where((reader) => reader.userId.eq(viewerId))
    .first();
  return row !== null && row !== undefined;
}

/**
 * A story by slug or id with no visibility filter, for a beta reader: one
 * written here, and not taken down by a moderator. A take-down shuts beta
 * readers out too, exactly as it shuts out the public.
 */
async function findBetaStoryRow(slugOrId: string): Promise<StoryRow | null> {
  const base = storiesBase()
    .where((story) => story.source.eq("SCRIBE"))
    .where((story) => story.hiddenAt.isNull());

  const row = await base.where((story) => story.slug.eq(slugOrId)).first();
  if (row) return row as StoryRow;
  if (!UUID.test(slugOrId)) return null;

  const byId = await base.where((story) => story.id.eq(slugOrId)).first();
  return (byId as StoryRow | undefined) ?? null;
}

/**
 * A story's card as a beta reader would see it, before visibility is asked.
 *
 * For the invite page only (`services/beta.ts`), which has to show somebody
 * holding a valid invite link what they are about to join -- usually a draft
 * they cannot otherwise see. The link is the authorisation; a taken-down
 * story has no card to show.
 */
export async function getBetaStoryCard(storyId: string): Promise<Story | null> {
  const row = await findBetaStoryRow(storyId);
  if (!row) return null;

  const [story] = await hydrate([row], null, new Set([row.id]));
  return story ?? null;
}

interface ReadableStory {
  row: StoryRow;
  access: StoryAccess;
}

/**
 * The story `slugOrId` names and how the caller reads it, or null when they
 * may not see it at all.
 *
 * `findStoryRow` stays the rule for everybody but beta readers; this only
 * adds them, and only when asked to.
 */
async function findReadableStory(
  slugOrId: string,
  viewerId: string | null,
  options: BetaOption = {},
): Promise<ReadableStory | null> {
  const row = await findStoryRow(slugOrId, viewerId);
  if (row) {
    if (row.authorId === viewerId) return { row, access: "author" };
    if (options.beta && viewerId !== null && (await isBetaReader(row.id, viewerId))) {
      return { row, access: "beta" };
    }
    return { row, access: "reader" };
  }

  if (!options.beta || viewerId === null) return null;

  const draft = await findBetaStoryRow(slugOrId);
  if (draft && (await isBetaReader(draft.id, viewerId))) {
    return { row: draft, access: "beta" };
  }
  return null;
}

/** The chapters of one story that `access` admits. */
function chaptersFor(storyId: string, access: StoryAccess) {
  const chapters = db.orm.content.Chapter.where((chapter) =>
    chapter.storyId.eq(storyId),
  );

  if (access === "author") return chapters;
  // A take-down unpublishes and sets `hiddenAt`; a beta reader gets every
  // other chapter, drafts included.
  if (access === "beta") return chapters.where((chapter) => chapter.hiddenAt.isNull());
  return chapters.where((chapter) => chapter.publishedAt.isNotNull());
}

/** `chaptersFor`'s rule, for one chapter already loaded. */
function chapterAdmits(
  chapter: { publishedAt: unknown; hiddenAt: unknown },
  access: StoryAccess,
): boolean {
  if (access === "author") return true;
  if (access === "beta") return chapter.hiddenAt === null || chapter.hiddenAt === undefined;
  return chapter.publishedAt !== null && chapter.publishedAt !== undefined;
}

/**
 * Whether `viewerId` is served story reads exactly as an anonymous reader is.
 *
 * The viewer-dependent things in a story list, a story's page, its related
 * rail and its chapter list are authorship and beta reading: an author also
 * sees their own drafts and counts their own unpublished chapters
 * (`visibleTo`, `chapterTotals`, `chaptersFor`), and a beta reader sees the
 * drafts they were invited to. Someone who is neither gets the public answer,
 * which is what lets `routes/stories.ts` share one cached copy between them
 * and every anonymous reader.
 *
 * Asked fresh on every request -- one probe each of the `authorId` and
 * `beta.reader.userId` indexes -- because the answer changes the moment a
 * reader creates their first draft or joins a beta, and a stale "no" would
 * show them a 404 for the story they just made or joined.
 */
export async function seesPublicView(viewerId: string | null): Promise<boolean> {
  if (viewerId === null) return true;

  // A beta reader is served a story's drafts, so neither may share the copy.
  const [own, beta] = await Promise.all([
    db.orm.content.Story.select("id")
      .where((story) => story.authorId.eq(viewerId))
      .first(),
    db.orm.beta.Reader.select("storyId")
      .where((reader) => reader.userId.eq(viewerId))
      .first(),
  ]);

  return (own === null || own === undefined) && (beta === null || beta === undefined);
}

const NOT_FOUND = "That story could not be found.";

/**
 * The id of the story `slugOrId` names, or null when there is none the caller
 * may see.
 *
 * Exported for `services/engagement.ts`, which has to answer "may this caller
 * see this story?" before listing its comments or accepting a rating. Going
 * through `findStoryRow` rather than re-implementing the check is the point:
 * `visibleTo` is the one place a draft is hidden, and a second copy of that
 * rule is exactly how a draft's comments would leak.
 *
 * Beta readers are admitted only with `{ beta: true }`: comments and ratings
 * are public, and must not be left on a draft. Highlights, which are private,
 * pass it.
 */
export async function findVisibleStoryId(
  slugOrId: string,
  viewerId: string | null,
  options: BetaOption = {},
): Promise<string | null> {
  const found = await findReadableStory(slugOrId, viewerId, options);
  return found?.row.id ?? null;
}

/**
 * How many of one author's stories the caller may see.
 *
 * Exported for `services/users.ts`, whose profile header would otherwise be
 * free to disagree with the story list beside it. It counts exactly what
 * `listStories` pages through for the same author -- `visibleTo`, so a
 * stranger is counted the published stories and an author viewing their own
 * profile is counted their drafts too, *and* `source = SCRIBE`, because a
 * catalogue edition bearing somebody's name is not a story they serialised
 * here and `listStories` has always excluded it.
 */
export async function countVisibleStoriesBy(
  authorId: string,
  viewerId: string | null,
): Promise<number> {
  const totals = await visibleTo(storiesBase(), viewerId)
    .where((story) => story.source.eq("SCRIBE"))
    .where((story) => story.authorId.eq(authorId))
    .aggregate((aggregate) => ({ total: aggregate.count() }));

  return totals.total;
}

/**
 * The next chapter an author has scheduled, as readers may know it: its
 * number and when it arrives, never its title, which can give the plot away.
 */
export interface NextRelease {
  number: number;
  scheduledAt: string;
}

/** One story's page: the card's fields, plus what is coming next. */
export interface StoryDetail extends Story {
  nextRelease: NextRelease | null;
  /**
   * How the caller reads it; see `StoryAccess`. `reader` on the shared
   * cached copy, which is only ever served to callers for whom that is true
   * (`seesPublicView`).
   */
  access: StoryAccess;
}

export async function getStory(
  slugOrId: string,
  viewerId: string | null,
): Promise<StoryDetail> {
  const found = await findReadableStory(slugOrId, viewerId, { beta: true });
  if (!found) throw HttpError.notFound(NOT_FOUND);
  const { row, access } = found;

  const [story] = await hydrate(
    [row],
    viewerId,
    access === "beta" ? new Set([row.id]) : undefined,
  );
  if (!story) throw HttpError.notFound(NOT_FOUND);

  return { ...story, nextRelease: await nextReleaseOf(row.id), access };
}

/**
 * The soonest scheduled chapter still to come. One indexed probe per story
 * page; the list endpoints do not carry it, because a card has nowhere to
 * show it.
 */
async function nextReleaseOf(storyId: string): Promise<NextRelease | null> {
  const row = await db.orm.content.Chapter.select("chapterNumber", "scheduledAt")
    .where((chapter) => chapter.storyId.eq(storyId))
    .where((chapter) => chapter.publishedAt.isNull())
    .where((chapter) => chapter.scheduledAt.isNotNull())
    .orderBy((chapter) => chapter.scheduledAt.asc())
    .first();

  const scheduledAt = row ? toIso(row.scheduledAt) : null;
  if (!row || scheduledAt === null) return null;

  return { number: row.chapterNumber, scheduledAt };
}

/** Chapters of one story, in reading order, without their bodies. */
export async function listChapters(
  slugOrId: string,
  viewerId: string | null,
): Promise<ChapterSummary[]> {
  const story = await findReadableStory(slugOrId, viewerId, { beta: true });
  if (!story) throw HttpError.notFound(NOT_FOUND);

  const rows = await chaptersFor(story.row.id, story.access)
    .select("id", "storyId", "chapterNumber", "title", "wordCount", "publishedAt", "scheduledAt")
    .orderBy((chapter) => chapter.chapterNumber.asc())
    .all();

  return rows.map((row) => ({
    id: row.id,
    storyId: row.storyId,
    number: row.chapterNumber,
    title: row.title,
    wordCount: row.wordCount,
    publishedAt: toIso(row.publishedAt),
    scheduledAt: toIso(row.scheduledAt),
  }));
}

export async function getChapter(
  slugOrId: string,
  number: number,
  viewerId: string | null,
): Promise<Chapter> {
  /**
   * An unpublished chapter is visible to its author and the story's beta
   * readers, so an author previewing a draft -- and a reader they invited --
   * read it through the same endpoint the audience will use.
   */
  const story = await findReadableStory(slugOrId, viewerId, { beta: true });
  if (!story) throw HttpError.notFound(NOT_FOUND);

  const visible = chaptersFor(story.row.id, story.access);

  const row = await visible
    .select(
      "id",
      "storyId",
      "chapterNumber",
      "title",
      "content",
      "wordCount",
      "publishedAt",
      "scheduledAt",
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
  const [previous, next, media, likes, myLike] = await Promise.all([
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
    /**
     * Counted from `engagement.ChapterLike` rather than read off a column:
     * there is no denormalised counter, for the reason the contract gives.
     * Both of these join the round trip the neighbours and the attachments
     * are already making, so the chapter read costs no extra latency.
     */
    db.orm.engagement.ChapterLike.where((like) => like.chapterId.eq(row.id))
      .aggregate((aggregate) => ({ total: aggregate.count() })),
    // Skipped for an anonymous reader, who cannot have liked anything.
    viewerId === null
      ? Promise.resolve(null)
      : db.orm.engagement.ChapterLike.select("userId")
          .where((like) => like.chapterId.eq(row.id))
          .where((like) => like.userId.eq(viewerId))
          .first(),
  ]);

  return {
    id: row.id,
    storyId: row.storyId,
    number: row.chapterNumber,
    title: row.title,
    content: row.content,
    wordCount: row.wordCount,
    publishedAt: toIso(row.publishedAt),
    scheduledAt: toIso(row.scheduledAt),
    multimedia: media.map((item) => ({
      id: item.id,
      type: item.type as ChapterMedia["type"],
      url: item.url,
      displayOrder: item.displayOrder,
    })),
    previousNumber: previous?.chapterNumber ?? null,
    nextNumber: next?.chapterNumber ?? null,
    likeCount: likes.total,
    likedByMe: myLike !== null && myLike !== undefined,
  };
}

/**
 * The chapter `chapterId` names, if the caller may read it.
 *
 * Exported for `services/engagement.ts`, which has to answer "may this caller
 * see this chapter?" before accepting a like on it -- the same reason
 * `findVisibleStoryId` above is exported, and answered the same way: through
 * `findReadableStory` and the rule `chaptersFor` applies, so
 * the two places a draft chapter is hidden cannot drift apart.
 */
export async function findVisibleChapter(
  chapterId: string,
  viewerId: string | null,
  options: BetaOption = {},
): Promise<{ id: string; storyId: string; number: number } | null> {
  const chapter = await db.orm.content.Chapter.select(
    "id",
    "storyId",
    "chapterNumber",
    "publishedAt",
    "hiddenAt",
  )
    .where((row) => row.id.eq(chapterId))
    .first();

  if (!chapter) return null;

  // A draft story hides its chapters from everybody but its author (and, with
  // `beta`, its beta readers), and this is where that is decided for every
  // caller.
  const story = await findReadableStory(chapter.storyId, viewerId, options);
  if (!story) return null;

  if (!chapterAdmits(chapter, story.access)) return null;

  return {
    id: chapter.id,
    storyId: chapter.storyId,
    number: chapter.chapterNumber,
  };
}

/**
 * Which of these chapters the caller may read, in one pass.
 *
 * Written for semantic search, which retrieves passages from a vector index
 * that knows nothing about drafts, and has to drop any it may not show before
 * quoting one. `findVisibleChapter` answers the same question for one chapter
 * in two queries; a page of search results can name fifty chapters, so this
 * asks it of all of them in two queries total.
 *
 * The rule is the one `chaptersFor` applies, over stories `visibleTo`
 * admits: a chapter is readable when its story is visible to the caller and
 * the chapter is published -- or the caller wrote it. Ids that name nothing
 * are simply absent from the answer.
 */
export async function findVisibleChapterIds(
  chapterIds: string[],
  viewerId: string | null,
  options: BetaOption = {},
): Promise<Set<string>> {
  if (chapterIds.length === 0) return new Set();

  const chapters = await db.orm.content.Chapter.select(
    "id",
    "storyId",
    "publishedAt",
    "hiddenAt",
  )
    .where((chapter) => chapter.id.in(chapterIds))
    .all();

  const storyIds = [...new Set(chapters.map((chapter) => chapter.storyId))];
  if (storyIds.length === 0) return new Set();

  const stories = await visibleTo(storiesBase(), viewerId)
    .where((story) => story.id.in(storyIds))
    .all();

  const accessByStory = new Map<string, StoryAccess>(
    stories.map((story) => [
      story.id,
      story.authorId === viewerId ? "author" : "reader",
    ]),
  );

  // The same widening `findReadableStory` makes, for a batch: stories the
  // caller beta-reads, unless a moderator took them down.
  if (options.beta && viewerId !== null) {
    const memberships = await db.orm.beta.Reader.select("storyId")
      .where((reader) => reader.userId.eq(viewerId))
      .where((reader) => reader.storyId.in(storyIds))
      .all();
    const candidates = memberships
      .map((membership) => membership.storyId)
      .filter((storyId) => accessByStory.get(storyId) !== "author");

    if (candidates.length > 0) {
      const open = await db.orm.content.Story.select("id")
        .where((story) => story.id.in(candidates))
        .where((story) => story.hiddenAt.isNull())
        .all();
      for (const story of open) accessByStory.set(story.id, "beta");
    }
  }

  return new Set(
    chapters
      .filter((chapter) => {
        // Absent from the map means the story itself is hidden from this
        // caller, which hides every chapter in it, published or not.
        const access = accessByStory.get(chapter.storyId);
        return access !== undefined && chapterAdmits(chapter, access);
      })
      .map((chapter) => chapter.id),
  );
}

/**
 * The chapter before `chapterNumber` that this caller may actually read, with
 * its text.
 *
 * **Not `chapterNumber - 1`.** An unpublished chapter in the middle of a story
 * is invisible to everybody but its author, and numbering can be uneven after
 * a deletion -- so the chapter preceding twelve is nine for one reader and
 * eleven for another. The reader's own prev/next links already work this way
 * (see `getChapter`); anything reading "the previous chapter" has to agree
 * with them or it will describe a chapter the reader cannot open.
 *
 * Written for the AI recap, which summarises this chapter for a reader
 * returning to a serial after a fortnight. It lives here rather than in
 * `services/ai/` because it is a visibility question, and every answer to a
 * visibility question in this codebase is in this file. A copy over there
 * would be the copy that eventually recaps a draft to a stranger.
 *
 * Returns null when there is no previous visible chapter, which is an ordinary
 * answer -- the first chapter of a story has none. A story the caller may not
 * see is a 404, because that is a different question with a different answer.
 */
export async function findPreviousVisibleChapter(
  slugOrId: string,
  chapterNumber: number,
  viewerId: string | null,
): Promise<{
  id: string;
  number: number;
  title: string;
  content: string;
} | null> {
  const story = await findReadableStory(slugOrId, viewerId);
  if (!story) throw HttpError.notFound(NOT_FOUND);

  const row = await chaptersFor(story.row.id, story.access)
    .select("id", "chapterNumber", "title", "content")
    .where((chapter) => chapter.chapterNumber.lt(chapterNumber))
    .orderBy((chapter) => chapter.chapterNumber.desc())
    .first();

  if (!row) return null;

  return {
    id: row.id,
    number: row.chapterNumber,
    title: row.title,
    content: row.content,
  };
}

/**
 * One visible chapter's prose, by id.
 *
 * `findVisibleChapter` above answers "may this caller see this chapter?" and
 * deliberately returns no text, because its callers only needed to authorise a
 * like. This answers the same question and returns the body, for the AI
 * explain feature -- which is handed a chapter id and a pair of offsets, and
 * has to read the passage out of the stored chapter itself rather than trust
 * prose sent in a request body.
 *
 * That indirection is the point of the function. A reader-facing endpoint that
 * accepts arbitrary text and forwards it to a model is a general-purpose model
 * proxy wearing a costume; one that accepts offsets into a chapter it looks up
 * can only ever explain published fiction.
 */
export async function findVisibleChapterText(
  chapterId: string,
  viewerId: string | null,
  options: BetaOption = {},
): Promise<{
  id: string;
  storyId: string;
  number: number;
  title: string;
  content: string;
} | null> {
  // The visibility decision itself is not repeated here -- it is the function
  // above, so the draft rule has exactly one implementation.
  const visible = await findVisibleChapter(chapterId, viewerId, options);
  if (!visible) return null;

  const row = await db.orm.content.Chapter.select("title", "content")
    .where((chapter) => chapter.id.eq(chapterId))
    .first();

  if (!row) return null;

  return {
    id: visible.id,
    storyId: visible.storyId,
    number: visible.number,
    title: row.title,
    content: row.content,
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

  /**
   * The best-liked listed stories sharing a genre with this one, chosen in
   * SQL. It used to load every story id in those genres to filter and sort in
   * memory, which grew with the catalogue. Drafts are excluded even for their
   * own author: this rail is a recommendation to a reader, not a view of the
   * caller's own shelf.
   */
  const picked = await db.runtime().query(
    db.raw.sql`
      SELECT s."id"
        FROM "content"."story" AS s
       WHERE s."id" <> ${story.id}
         AND s."listedAt" IS NOT NULL
         AND s."source" = 'SCRIBE'
         AND EXISTS (
               SELECT 1
                 FROM "content"."storyGenre" AS sg
                WHERE sg."storyId" = s."id"
                  AND sg."genreId" IN (
                        SELECT "genreId" FROM "content"."storyGenre" WHERE "storyId" = ${story.id}
                      )
             )
       ORDER BY s."likeCount" DESC, s."id" DESC
       LIMIT ${limit}::int
    `.returnsRow({ id: "pg/text@1" }).build(),
  );

  if (picked.length === 0) return [];

  const order = picked.map((row) => row.id);
  const rows = await storiesBase()
    .where((candidate) => candidate.id.in(order))
    .all();
  rows.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

  return hydrate(rows as StoryRow[], viewerId);
}

/**
 * Several stories by id, hydrated the same way a listing is, keyed by id.
 *
 * For callers holding ids from another table -- reading history, a shelf --
 * that need story cards without a query per row. Ids the caller may not see
 * are simply absent from the map rather than an error: the caller's own rows
 * can outlive a story being unlisted, and that should thin the list, not fail
 * the request.
 */
export async function getStoriesByIds(
  storyIds: string[],
  viewerId: string | null,
): Promise<Map<string, Story>> {
  if (storyIds.length === 0) return new Map();

  const rows = await visibleTo(storiesBase(), viewerId)
    .where((story) => story.id.in(storyIds))
    .all();

  const stories = await hydrate(rows as StoryRow[], viewerId);
  return new Map(stories.map((story) => [story.id, story]));
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
  // Counted in one grouped statement rather than by loading every link and
  // every listed story to count in memory, which grew with the catalogue on
  // every request.
  const rows = await db.runtime().query(
    db.raw.sql`
      SELECT g."id", g."name", g."hue", count(s."id")::int AS "storyCount"
        FROM "content"."genre" AS g
        LEFT JOIN "content"."storyGenre" AS sg ON sg."genreId" = g."id"
        LEFT JOIN "content"."story" AS s
               ON s."id" = sg."storyId"
              AND s."listedAt" IS NOT NULL
              AND s."source" = 'SCRIBE'
       GROUP BY g."id", g."name", g."hue"
       ORDER BY g."name" ASC
    `.returnsRow({
      id: "pg/text@1",
      name: "pg/text@1",
      hue: "pg/int4@1",
      storyCount: "pg/int4@1",
    }).build(),
  );

  return rows.map((row) => ({ ...row }));
}
