/**
 * Reading lists: a reader's named, curated selection of stories, with an
 * optional note on each, that other readers can follow.
 *
 * Shaped after `services/channels.ts`, the other thing one person writes for
 * others to follow. A list has exactly one privileged user -- its owner -- so
 * every write goes through `ownedList`, the only place ownership is decided.
 *
 * Six decisions live here.
 *
 * - **Any story a reader can find.** A listed Scribe story or a catalogue
 *   book (both are `content.Story`), never a draft. A story that is later
 *   unlisted or taken down keeps its entry and is left out of every read --
 *   counts, previews, the list page -- so it comes back if the story does.
 *   Hiding a story clears `listedAt`, so `listedAt IS NOT NULL` is the whole
 *   test.
 * - **Public or private.** A private list is its owner's alone: anybody else
 *   gets the 404 a missing list gets, cannot follow it, and its followers
 *   hear nothing while it stays private. Followers are kept, so making it
 *   public again brings them back.
 * - **Taken down whole.** A moderator hides the list -- name, description
 *   and notes -- through `hiddenAt`, which `listsBase` filters for everybody,
 *   the owner included; see `services/moderation.ts`.
 * - **Following notifies, once per sitting.** Adding a story to a public list
 *   tells its followers (`LIST_ADDITION`), but not a follower who has yet to
 *   read the last one for that list; see `notifyListFollowers`.
 * - **Suspension stops the words, not the housekeeping.** Creating or editing
 *   a list and adding a story or a note put text in front of readers, so they
 *   call `assertNotSuspended`. Removing a story, deleting a list and following
 *   do not.
 * - **Bounded.** `MAX_LISTS_PER_USER` lists per reader and
 *   `MAX_ENTRIES_PER_LIST` stories per list, so a list page is one read of a
 *   bounded set and an owner's lists never need paging.
 */

import { Temporal } from "temporal-polyfill";
import { db } from "../prisma/db.js";
import { HttpError } from "../lib/http-error.js";
import { slugify } from "../lib/slug.js";
import { notify } from "./notifications.js";
import { assertNotSuspended } from "./roles.js";
import { getStoriesByIds, toIso, type Story } from "./stories.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type Orm = Pick<Tx, "orm"> | typeof db;

/* Limits ----------------------------------------------------------------- */

export const MAX_LISTS_PER_USER = 50;
export const MAX_ENTRIES_PER_LIST = 100;
export const NAME_MAX_LENGTH = 80;
export const DESCRIPTION_MAX_LENGTH = 1000;
export const NOTE_MAX_LENGTH = 500;
/** One page can hold all of a reader's lists, which is how they are asked for. */
export const MAX_PAGE_SIZE = MAX_LISTS_PER_USER;

/** How many covers a list card shows. */
const PREVIEW_COUNT = 4;

export const LIST_SORTS = ["popular", "recent"] as const;

export type ListSort = (typeof LIST_SORTS)[number];

export const LIST_NOT_FOUND = "That list could not be found.";

const STORY_NOT_FOUND = "That story could not be found.";

const ENTRY_NOT_FOUND = "That story is not on this list.";

/* Shapes returned to the client ------------------------------------------ */

export interface ListOwner {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface ReadingList {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  isPublic: boolean;
  createdAt: string;
  /** Moves when the list is edited or a story is added or removed. */
  updatedAt: string;
  owner: ListOwner;
  /** Stories a reader can open, not entries that exist. */
  storyCount: number;
  followerCount: number;
  /** The caller follows it; always false when signed out. */
  following: boolean;
  /** The caller owns it. */
  isOwner: boolean;
  /** The newest few stories on it, for the card's covers. */
  previews: Story[];
  /**
   * Whether a given story is on the list. Present only when the caller asked
   * about one (`storyId`), which the "Add to list" dialog does.
   */
  hasStory?: boolean;
}

export interface ListEntry {
  id: string;
  note: string | null;
  addedAt: string;
  updatedAt: string;
  story: Story;
}

export interface ReadingListDetail extends ReadingList {
  /** Newest first. */
  entries: ListEntry[];
}

export interface Page<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

export interface ListQuery {
  /** One reader's lists, by username: all of them for the owner, else the public ones. */
  owner?: string | undefined;
  /** The lists the caller follows. Empty when signed out. */
  followed?: boolean | undefined;
  /** Adds `hasStory` for this story to each list. */
  storyId?: string | undefined;
  sort: ListSort;
  page: number;
  limit: number;
}

/* Helpers ---------------------------------------------------------------- */

function now(): Temporal.Instant {
  return Temporal.Now.instant();
}

function isoOf(value: unknown): string {
  return toIso(value) ?? new Date(0).toISOString();
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function emptyPage<T>(page: number, limit: number): Page<T> {
  return { items: [], page, limit, total: 0, totalPages: 0, hasMore: false };
}

function pageOf<T>(all: T[], page: number, limit: number): Page<T> {
  return {
    items: all.slice((page - 1) * limit, page * limit),
    page,
    limit,
    total: all.length,
    totalPages: Math.ceil(all.length / limit),
    hasMore: page * limit < all.length,
  };
}

interface ListRow {
  id: string;
  userId: string;
  slug: string;
  name: string;
  description: string | null;
  isPublic: boolean;
  createdAt: unknown;
  updatedAt: unknown;
}

function listsBase(client: Orm = db) {
  return client.orm.lists.ReadingList.select(
    "id",
    "userId",
    "slug",
    "name",
    "description",
    "isPublic",
    "createdAt",
    "updatedAt",
  )
    // A list a moderator took down reads as absent to everybody, its owner
    // included. Every list read starts here, so this is the whole filter.
    .where((list) => list.hiddenAt.isNull());
}

/** Whether `viewerId` may see the list at all. */
function visibleTo(row: ListRow, viewerId: string | null): boolean {
  return row.isPublic || row.userId === viewerId;
}

/**
 * A list's slug: the name's, or the name's with a short random tail when that
 * is taken.
 *
 * Not `uniqueSlug`'s counting suffix. Lists are named "Favourites" and "To
 * read" by thousands of readers, and counting up to the first free number is
 * a query per taken one; a random tail is one more query, almost always.
 */
async function newSlug(client: Orm, name: string): Promise<string> {
  const base = slugify(name).slice(0, 60).replace(/-+$/g, "") || "list";

  const taken = async (candidate: string) =>
    (await client.orm.lists.ReadingList.select("id")
      .where((list) => list.slug.eq(candidate))
      .first()) != null;

  if (!(await taken(base))) return base;

  for (;;) {
    const tail = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
    const candidate = `${base}-${tail}`;
    if (!(await taken(candidate))) return candidate;
  }
}

/** Which of these story ids a reader can open: listed, and not taken down. */
async function readableStoryIds(storyIds: string[]): Promise<Set<string>> {
  const unique = [...new Set(storyIds)];
  if (unique.length === 0) return new Set();

  const rows = await db.orm.content.Story.select("id")
    .where((story) => story.id.in(unique))
    .where((story) => story.listedAt.isNotNull())
    .all();

  return new Set(rows.map((row) => row.id));
}

/**
 * Attaches the owner, the two counts, the caller's follow and the covers.
 *
 * Per set of lists rather than per list, so a grid of twelve costs a fixed
 * handful of queries. Entries are read whole -- at most
 * `MAX_ENTRIES_PER_LIST` each -- because the count has to leave out stories
 * nobody can open, and that is a question about the story, not the entry.
 */
async function hydrate(
  rows: ListRow[],
  viewerId: string | null,
  storyId?: string,
): Promise<ReadingList[]> {
  if (rows.length === 0) return [];

  const listIds = rows.map((row) => row.id);

  const ownerRows = await db.orm.auth.User.select(
    "id",
    "username",
    "displayName",
    "avatarUrl",
  )
    .where((user) => user.id.in([...new Set(rows.map((row) => row.userId))]))
    .all();
  const owners = new Map(ownerRows.map((row) => [row.id, row]));

  const entries = await db.orm.lists.ListEntry.select("listId", "storyId", "addedAt")
    .where((entry) => entry.listId.in(listIds))
    .orderBy([(entry) => entry.addedAt.desc(), (entry) => entry.id.desc()])
    .all();

  const readable = await readableStoryIds(entries.map((entry) => entry.storyId));

  const storyCounts = new Map<string, number>();
  const previewIds = new Map<string, string[]>();
  const holding = new Set<string>();

  for (const entry of entries) {
    if (storyId !== undefined && entry.storyId === storyId) holding.add(entry.listId);
    if (!readable.has(entry.storyId)) continue;

    storyCounts.set(entry.listId, (storyCounts.get(entry.listId) ?? 0) + 1);

    const previews = previewIds.get(entry.listId) ?? [];
    if (previews.length < PREVIEW_COUNT) {
      previews.push(entry.storyId);
      previewIds.set(entry.listId, previews);
    }
  }

  const stories = await getStoriesByIds([...previewIds.values()].flat(), null);

  const followerGroups = await db.orm.lists.ListFollower.where((row) =>
    row.listId.in(listIds),
  )
    .groupBy("listId")
    .aggregate((aggregate) => ({ count: aggregate.count() }));
  const followerCounts = new Map(
    followerGroups.map((group) => [group.listId, group.count]),
  );

  const followed = new Set<string>();
  if (viewerId !== null) {
    const mine = await db.orm.lists.ListFollower.select("listId")
      .where((row) => row.userId.eq(viewerId))
      .where((row) => row.listId.in(listIds))
      .all();
    for (const row of mine) followed.add(row.listId);
  }

  return rows
    .map((row): ReadingList | null => {
      // A list whose owner is gone drops out rather than failing the page.
      const owner = owners.get(row.userId);
      if (!owner) return null;

      return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        description: row.description,
        isPublic: row.isPublic,
        createdAt: isoOf(row.createdAt),
        updatedAt: isoOf(row.updatedAt),
        owner: {
          id: owner.id,
          username: owner.username,
          displayName: owner.displayName,
          avatarUrl: owner.avatarUrl,
        },
        storyCount: storyCounts.get(row.id) ?? 0,
        followerCount: followerCounts.get(row.id) ?? 0,
        following: followed.has(row.id),
        isOwner: viewerId !== null && row.userId === viewerId,
        previews: (previewIds.get(row.id) ?? []).flatMap((id) => {
          const story = stories.get(id);
          return story ? [story] : [];
        }),
        ...(storyId === undefined ? {} : { hasStory: holding.has(row.id) }),
      };
    })
    .filter((list): list is ReadingList => list !== null);
}

/**
 * One list by slug or by id, whoever may see it. The id branch is only tried
 * for something shaped like a UUID, as in `services/channels.ts`.
 */
async function findListRow(
  slugOrId: string,
  client: Orm = db,
): Promise<ListRow | null> {
  const bySlug = await listsBase(client)
    .where((list) => list.slug.eq(slugOrId))
    .first();
  if (bySlug) return bySlug as ListRow;

  if (!UUID.test(slugOrId)) return null;

  const byId = await listsBase(client)
    .where((list) => list.id.eq(slugOrId))
    .first();
  return (byId as ListRow | undefined) ?? null;
}

/** The list, if `viewerId` may see it; else the 404 a missing one gets. */
async function visibleList(
  slugOrId: string,
  viewerId: string | null,
  client: Orm = db,
): Promise<ListRow> {
  const row = await findListRow(slugOrId, client);
  if (!row || !visibleTo(row, viewerId)) throw HttpError.notFound(LIST_NOT_FOUND);
  return row;
}

/**
 * The list, once the caller is established as its owner.
 *
 * 404 for a list the caller cannot see, 403 for a public one that is not
 * theirs -- its existence is public, its editing is not. A private list of
 * somebody else's is a 404, so this never confirms that one exists.
 */
async function ownedList(
  client: Orm,
  slugOrId: string,
  userId: string,
): Promise<ListRow> {
  const row = await visibleList(slugOrId, userId, client);

  if (row.userId !== userId) {
    throw HttpError.forbidden("That list is not yours to change.");
  }

  return row;
}

/* Reads ------------------------------------------------------------------ */

/**
 * Public lists with at least one story a reader can open, for browsing and
 * Discover. `popular` is most followed first; `recent`, most recently
 * changed. Paged in SQL, since this is the one set that grows with the site.
 */
async function browseLists(
  query: ListQuery,
  viewerId: string | null,
): Promise<Page<ReadingList>> {
  const limit = query.limit;
  const offset = (query.page - 1) * limit;

  const [counted] = await db.runtime().query(
    db.raw.sql`
      SELECT count(*)::int AS "total"
        FROM "lists"."readingList" AS l
       WHERE l."hiddenAt" IS NULL
         AND l."isPublic"
         AND EXISTS (
               SELECT 1
                 FROM "lists"."listEntry" AS e
                 JOIN "content"."story" AS s ON s."id" = e."storyId"
                WHERE e."listId" = l."id"
                  AND s."listedAt" IS NOT NULL
             )
    `.returnsRow({ total: "pg/int4@1" }).build(),
  );
  const total = counted?.total ?? 0;
  if (total === 0) return emptyPage(query.page, limit);

  const picked =
    query.sort === "popular"
      ? await db.runtime().query(
          db.raw.sql`
            SELECT l."id"
              FROM "lists"."readingList" AS l
             WHERE l."hiddenAt" IS NULL
               AND l."isPublic"
               AND EXISTS (
                     SELECT 1
                       FROM "lists"."listEntry" AS e
                       JOIN "content"."story" AS s ON s."id" = e."storyId"
                      WHERE e."listId" = l."id"
                        AND s."listedAt" IS NOT NULL
                   )
             ORDER BY (SELECT count(*) FROM "lists"."listFollower" AS f WHERE f."listId" = l."id") DESC,
                      l."updatedAt" DESC, l."id" ASC
             LIMIT ${limit}::int OFFSET ${offset}::int
          `.returnsRow({ id: "pg/text@1" }).build(),
        )
      : await db.runtime().query(
          db.raw.sql`
            SELECT l."id"
              FROM "lists"."readingList" AS l
             WHERE l."hiddenAt" IS NULL
               AND l."isPublic"
               AND EXISTS (
                     SELECT 1
                       FROM "lists"."listEntry" AS e
                       JOIN "content"."story" AS s ON s."id" = e."storyId"
                      WHERE e."listId" = l."id"
                        AND s."listedAt" IS NOT NULL
                   )
             ORDER BY l."updatedAt" DESC, l."id" ASC
             LIMIT ${limit}::int OFFSET ${offset}::int
          `.returnsRow({ id: "pg/text@1" }).build(),
        );

  const order = picked.map((row) => row.id);
  const rows =
    order.length === 0
      ? []
      : ((await listsBase()
          .where((list) => list.id.in(order))
          .all()) as ListRow[]);
  rows.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

  return {
    items: await hydrate(rows, viewerId, query.storyId),
    page: query.page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
    hasMore: query.page * limit < total,
  };
}

export async function listReadingLists(
  query: ListQuery,
  viewerId: string | null,
): Promise<Page<ReadingList>> {
  if (query.owner !== undefined) {
    const owner = await db.orm.auth.User.select("id")
      .where((user) => user.username.eq(query.owner!.trim().toLowerCase()))
      .first();
    if (!owner) throw HttpError.notFound("That reader could not be found.");

    let collection = listsBase().where((list) => list.userId.eq(owner.id));
    if (owner.id !== viewerId) {
      collection = collection.where((list) => list.isPublic.eq(true));
    }

    // At most `MAX_LISTS_PER_USER`, so read whole and paged here.
    const rows = (await collection
      .orderBy([(list) => list.updatedAt.desc(), (list) => list.id.desc()])
      .all()) as ListRow[];

    return pageOf(await hydrate(rows, viewerId, query.storyId), query.page, query.limit);
  }

  if (query.followed) {
    if (viewerId === null) return emptyPage(query.page, query.limit);

    const follows = await db.orm.lists.ListFollower.select("listId")
      .where((row) => row.userId.eq(viewerId))
      .orderBy([(row) => row.followedAt.desc(), (row) => row.listId.asc()])
      .all();
    const order = follows.map((row) => row.listId);
    if (order.length === 0) return emptyPage(query.page, query.limit);

    // A followed list that went private or was taken down drops out, and
    // comes back if it returns.
    const rows = ((await listsBase()
      .where((list) => list.id.in(order))
      .all()) as ListRow[]).filter((row) => visibleTo(row, viewerId));
    rows.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

    return pageOf(await hydrate(rows, viewerId, query.storyId), query.page, query.limit);
  }

  return browseLists(query, viewerId);
}

export async function getReadingList(
  slugOrId: string,
  viewerId: string | null,
): Promise<ReadingListDetail> {
  const row = await visibleList(slugOrId, viewerId);

  const [list] = await hydrate([row], viewerId);
  if (!list) throw HttpError.notFound(LIST_NOT_FOUND);

  const entryRows = await db.orm.lists.ListEntry.select(
    "id",
    "storyId",
    "note",
    "addedAt",
    "updatedAt",
  )
    .where((entry) => entry.listId.eq(row.id))
    .orderBy([(entry) => entry.addedAt.desc(), (entry) => entry.id.desc()])
    .all();

  // Anonymous on purpose: a list shows what anybody can open, so the owner's
  // own drafts do not appear on it even to the owner.
  const stories = await getStoriesByIds(
    entryRows.map((entry) => entry.storyId),
    null,
  );

  return {
    ...list,
    entries: entryRows.flatMap((entry) => {
      const story = stories.get(entry.storyId);
      if (!story) return [];

      return [
        {
          id: entry.id,
          note: entry.note,
          addedAt: isoOf(entry.addedAt),
          updatedAt: isoOf(entry.updatedAt),
          story,
        },
      ];
    }),
  };
}

/* Writing lists ---------------------------------------------------------- */

export interface ListInput {
  name: string;
  description?: string | null | undefined;
  isPublic?: boolean | undefined;
}

export async function createReadingList(
  userId: string,
  input: ListInput,
): Promise<ReadingListDetail> {
  // Puts text in front of readers; see `routes/suspension.test.ts`.
  await assertNotSuspended(userId);

  const owned = await db.orm.lists.ReadingList.where((list) =>
    list.userId.eq(userId),
  ).aggregate((aggregate) => ({ total: aggregate.count() }));

  if (owned.total >= MAX_LISTS_PER_USER) {
    throw HttpError.badRequest(
      `You can keep up to ${MAX_LISTS_PER_USER} lists. Delete one to start another.`,
    );
  }

  const timestamp = now();

  const listId = await db.transaction(async (tx) => {
    const created = await tx.orm.lists.ReadingList.select("id").create({
      userId,
      name: input.name,
      slug: await newSlug(tx, input.name),
      description: input.description ?? null,
      isPublic: input.isPublic ?? true,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return created.id;
  });

  return getReadingList(listId, userId);
}

export async function updateReadingList(
  userId: string,
  slugOrId: string,
  input: Partial<ListInput>,
): Promise<ReadingListDetail> {
  // Puts text in front of readers; see `routes/suspension.test.ts`.
  await assertNotSuspended(userId);

  const listId = await db.transaction(async (tx) => {
    const list = await ownedList(tx, slugOrId, userId);

    const changes: Record<string, unknown> = { updatedAt: now() };
    if (input.name !== undefined) changes["name"] = input.name;
    if (input.description !== undefined) changes["description"] = input.description ?? null;
    if (input.isPublic !== undefined) changes["isPublic"] = input.isPublic;

    // The slug stays through a rename: followers and shared links address
    // the list by it, as with channels and stories.
    await tx.orm.lists.ReadingList.where((row) => row.id.eq(list.id)).update(changes);

    return list.id;
  });

  return getReadingList(listId, userId);
}

/**
 * Deletes the list, its entries and its follows (foreign keys cascade), and
 * the notifications that announced additions to it, which would otherwise
 * link to a page that is gone.
 */
export async function deleteReadingList(
  userId: string,
  slugOrId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const list = await ownedList(tx, slugOrId, userId);

    await tx.query(
      db.raw.sql`
        DELETE FROM "notifications"."notification"
         WHERE "sourceType" = 'READING_LIST'
           AND "sourceId" = ${list.id}
      `.affectedCount().build(),
    );

    await tx.orm.lists.ReadingList.where((row) => row.id.eq(list.id)).delete();
  });
}

/* Entries ---------------------------------------------------------------- */

async function entryOf(
  listId: string,
  storyId: string,
): Promise<ListEntry> {
  const row = await db.orm.lists.ListEntry.select(
    "id",
    "storyId",
    "note",
    "addedAt",
    "updatedAt",
  )
    .where((entry) => entry.listId.eq(listId))
    .where((entry) => entry.storyId.eq(storyId))
    .first();
  if (!row) throw HttpError.notFound(ENTRY_NOT_FOUND);

  const story = (await getStoriesByIds([storyId], null)).get(storyId);
  if (!story) throw HttpError.notFound(STORY_NOT_FOUND);

  return {
    id: row.id,
    note: row.note,
    addedAt: isoOf(row.addedAt),
    updatedAt: isoOf(row.updatedAt),
    story,
  };
}

export async function addListEntry(
  userId: string,
  slugOrId: string,
  storyId: string,
  note: string | null,
): Promise<ListEntry> {
  // Puts text in front of readers -- the note, and the choice itself.
  await assertNotSuspended(userId);

  const timestamp = now();

  const { listId, entryId } = await db.transaction(async (tx) => {
    const list = await ownedList(tx, slugOrId, userId);

    // A draft reads as absent, as it does everywhere else a reader looks.
    if (!(await readableStoryIds([storyId])).has(storyId)) {
      throw HttpError.notFound(STORY_NOT_FOUND);
    }

    const existing = await tx.orm.lists.ListEntry.select("id")
      .where((entry) => entry.listId.eq(list.id))
      .where((entry) => entry.storyId.eq(storyId))
      .first();
    if (existing) throw HttpError.conflict("That story is already on this list.");

    const held = await tx.orm.lists.ListEntry.where((entry) =>
      entry.listId.eq(list.id),
    ).aggregate((aggregate) => ({ total: aggregate.count() }));
    if (held.total >= MAX_ENTRIES_PER_LIST) {
      throw HttpError.badRequest(
        `A list holds up to ${MAX_ENTRIES_PER_LIST} stories. Remove one to add another.`,
      );
    }

    let created;
    try {
      created = await tx.orm.lists.ListEntry.select("id").create({
        listId: list.id,
        storyId,
        note,
        addedAt: timestamp,
        updatedAt: timestamp,
      });
    } catch (error) {
      // Two adds at once: the unique index decides, and the loser is told
      // what the pre-check above would have said.
      if (isUniqueViolation(error)) {
        throw HttpError.conflict("That story is already on this list.");
      }
      throw error;
    }

    await tx.orm.lists.ReadingList.where((row) => row.id.eq(list.id)).update({
      updatedAt: timestamp,
    });

    return { listId: list.id, entryId: created.id };
  });

  // After the commit and unawaited, as every fan-out is. The resolver
  // decides whether the list is public and who has already been told.
  notify({ event: "list-addition", actorId: userId, entryId });

  return entryOf(listId, storyId);
}

export async function updateListEntry(
  userId: string,
  slugOrId: string,
  storyId: string,
  note: string | null,
): Promise<ListEntry> {
  // A note is text in front of readers.
  await assertNotSuspended(userId);

  const timestamp = now();

  const listId = await db.transaction(async (tx) => {
    const list = await ownedList(tx, slugOrId, userId);

    const entry = await tx.orm.lists.ListEntry.select("id")
      .where((row) => row.listId.eq(list.id))
      .where((row) => row.storyId.eq(storyId))
      .first();
    if (!entry) throw HttpError.notFound(ENTRY_NOT_FOUND);

    await tx.orm.lists.ListEntry.where((row) => row.id.eq(entry.id)).update({
      note,
      updatedAt: timestamp,
    });
    await tx.orm.lists.ReadingList.where((row) => row.id.eq(list.id)).update({
      updatedAt: timestamp,
    });

    return list.id;
  });

  return entryOf(listId, storyId);
}

export async function removeListEntry(
  userId: string,
  slugOrId: string,
  storyId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const list = await ownedList(tx, slugOrId, userId);

    const entry = await tx.orm.lists.ListEntry.select("id")
      .where((row) => row.listId.eq(list.id))
      .where((row) => row.storyId.eq(storyId))
      .first();
    if (!entry) throw HttpError.notFound(ENTRY_NOT_FOUND);

    await tx.orm.lists.ListEntry.where((row) => row.id.eq(entry.id)).delete();
    await tx.orm.lists.ReadingList.where((row) => row.id.eq(list.id)).update({
      updatedAt: now(),
    });
  });
}

/* Following -------------------------------------------------------------- */

/**
 * Follows a list the caller can see and does not own. Idempotent, as
 * subscribing to a channel is: following twice succeeds.
 */
export async function followList(
  userId: string,
  slugOrId: string,
): Promise<{ following: true; followerCount: number }> {
  const list = await visibleList(slugOrId, userId);

  if (list.userId === userId) {
    throw HttpError.badRequest("You cannot follow your own list.");
  }

  try {
    await db.orm.lists.ListFollower.create({
      listId: list.id,
      userId,
      followedAt: now(),
    });
  } catch (error) {
    // Already following: the outcome the caller asked for.
    if (!isUniqueViolation(error)) throw error;
  }

  return { following: true, followerCount: await followerCount(list.id) };
}

/**
 * Stops following. Idempotent, and allowed for a list that has since gone
 * private, so nobody is stuck following something they can no longer open.
 */
export async function unfollowList(
  userId: string,
  slugOrId: string,
): Promise<{ following: false; followerCount: number }> {
  const list = await findListRow(slugOrId);
  if (!list) throw HttpError.notFound(LIST_NOT_FOUND);

  await db.orm.lists.ListFollower.where((row) => row.listId.eq(list.id))
    .where((row) => row.userId.eq(userId))
    .delete();

  return {
    following: false,
    followerCount: visibleTo(list, userId) ? await followerCount(list.id) : 0,
  };
}

async function followerCount(listId: string): Promise<number> {
  const { total } = await db.orm.lists.ListFollower.where((row) =>
    row.listId.eq(listId),
  ).aggregate((aggregate) => ({ total: aggregate.count() }));
  return total;
}

/** Postgres reports a unique-constraint breach as SQLSTATE 23505. */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  const candidate = error as { code?: unknown; sqlState?: unknown; cause?: unknown };
  if (candidate.code === "23505" || candidate.sqlState === "23505") return true;

  return candidate.cause !== undefined && isUniqueViolation(candidate.cause);
}
