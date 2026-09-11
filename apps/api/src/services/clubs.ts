/**
 * Book clubs: the club itself, its membership roll, and its discussions.
 *
 * Two things are enforced here and nowhere else:
 *
 * - **Authorisation reads the membership, never `BookClub.creatorId`.** The
 *   creator column records who started the club; the `OWNER` membership
 *   records who runs it now, and ownership transfers. Every privileged action
 *   goes through `requireRole`, which resolves the caller's membership row.
 * - **A club always has exactly one owner.** The last owner cannot leave, be
 *   demoted, or be deleted out of the club without handing ownership to
 *   somebody else first; the guard lives in `assertNotLastOwner` and every
 *   path that could strip an owner calls it inside its own transaction.
 *
 * Every function takes the caller's id explicitly -- the routes resolve it
 * once through `middleware/current-user.ts` -- so nothing here reaches for
 * ambient request state.
 */

import { Temporal } from "temporal-polyfill";
import { or } from "@prisma/orm-postgres/orm-client";
import { db } from "../prisma/db.js";
import { HttpError } from "../lib/http-error.js";
import { uniqueSlug } from "../lib/slug.js";
import { getStoriesByIds, toIso, type Story } from "./stories.js";

/**
 * The transaction context, so the guards below can take one. Derived from
 * `db.transaction` rather than imported for the reason `services/authoring.ts`
 * gives: the type is not re-exported from the runtime entry point.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Either the transaction context or the client itself. */
type Orm = Pick<Tx, "orm"> | typeof db;

/* Shapes returned to the client ----------------------------------------- */

export const CLUB_ROLES = ["OWNER", "ADMIN", "MEMBER"] as const;

export type ClubRole = (typeof CLUB_ROLES)[number];

export interface ClubUser {
  id: string;
  username: string;
  /** Absent for password signups, where the UI falls back to the username. */
  displayName: string | null;
  avatarUrl: string | null;
}

export interface ClubMember {
  user: ClubUser;
  role: ClubRole;
  joinedAt: string;
}

/** The caller's own standing in a club; null when anonymous or not a member. */
export interface ClubMembership {
  role: ClubRole;
  joinedAt: string;
}

export interface Club {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  memberCount: number;
  /** Top-level threads only, not threads plus replies. */
  discussionCount: number;
  createdAt: string;
  updatedAt: string;
  /**
   * The `OWNER` membership's user. Null only if the roll is somehow empty --
   * which the invariants above are meant to prevent, but a read path should
   * render a club rather than fail on it.
   */
  owner: ClubUser | null;
  /**
   * The club's current read, or null between reads. Resolved through the
   * story visibility rule, so a club whose current read is a draft shows null
   * to everyone but its author rather than leaking the title.
   */
  currentStory: Story | null;
  membership: ClubMembership | null;
}

export interface ClubDetail extends Club {
  /** `OWNER` and `ADMIN` members, for the club's moderator list. */
  moderators: ClubMember[];
}

export interface Discussion {
  id: string;
  clubId: string;
  /** Null for a top-level thread; the thread's id for a reply. */
  parentId: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  /** Always 0 for a reply: replies are one level deep. */
  replyCount: number;
  user: ClubUser;
}

export interface Page<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

export const MAX_PAGE_SIZE = 48;

export interface ClubQuery {
  search?: string | undefined;
  /** Only clubs the caller belongs to. Ignored for an anonymous caller. */
  mine?: boolean | undefined;
  sort: ClubSort;
  page: number;
  limit: number;
}

export const CLUB_SORTS = ["members", "newest", "name"] as const;

export type ClubSort = (typeof CLUB_SORTS)[number];

export const CLUB_NOT_FOUND = "That book club could not be found.";

const DISCUSSION_NOT_FOUND = "That discussion could not be found.";

/* Helpers ---------------------------------------------------------------- */

/** `now()` in the spelling the timestamp codec writes. */
function now(): Temporal.Instant {
  return Temporal.Now.instant();
}

/**
 * Timestamps are never null on these tables, but `toIso` is typed for columns
 * that can be. Falling back to the epoch rather than throwing keeps a single
 * malformed row from failing a whole list.
 */
function isoOf(value: unknown): string {
  return toIso(value) ?? new Date(0).toISOString();
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toUser(row: {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}): ClubUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
  };
}

/**
 * The user summaries for a set of ids, in one query rather than one per row.
 */
async function usersByIds(
  client: Orm,
  userIds: string[],
): Promise<Map<string, ClubUser>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Map();

  const rows = await client.orm.auth.User.select(
    "id",
    "username",
    "displayName",
    "avatarUrl",
  )
    .where((user) => user.id.in(unique))
    .all();

  return new Map(rows.map((row) => [row.id, toUser(row)]));
}

interface ClubRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  creatorId: string;
  currentStoryId: string | null;
  createdAt: unknown;
  updatedAt: unknown;
}

/**
 * Attaches everything a club card needs: counts, the current owner, the
 * current read, and the caller's own membership.
 *
 * Gathered per set of clubs rather than per club, so a list of 12 costs a
 * fixed handful of queries instead of 12 times as many.
 */
async function hydrate(
  rows: ClubRow[],
  viewerId: string | null,
): Promise<Club[]> {
  if (rows.length === 0) return [];

  const clubIds = rows.map((row) => row.id);

  const memberships = await db.orm.clubs.ClubMembership.select(
    "clubId",
    "userId",
    "role",
    "joinedAt",
  )
    .where((entry) => entry.clubId.in(clubIds))
    .all();

  // Top-level threads only: a reply is not a discussion in its own right, and
  // counting both would make the number disagree with the list beside it.
  const threads = await db.orm.clubs.ClubDiscussion.select("clubId")
    .where((row) => row.clubId.in(clubIds))
    .where((row) => row.parentId.isNull())
    .all();

  const memberCounts = new Map<string, number>();
  const discussionCounts = new Map<string, number>();
  const owners = new Map<string, { userId: string; joinedAt: unknown }>();
  const mine = new Map<string, ClubMembership>();

  for (const entry of memberships) {
    memberCounts.set(entry.clubId, (memberCounts.get(entry.clubId) ?? 0) + 1);

    if (entry.role === "OWNER") {
      // Oldest membership wins, so a club that somehow carries two owners
      // still reports one stable answer rather than an arbitrary one.
      const held = owners.get(entry.clubId);
      if (!held || isoOf(entry.joinedAt) < isoOf(held.joinedAt)) {
        owners.set(entry.clubId, { userId: entry.userId, joinedAt: entry.joinedAt });
      }
    }

    if (viewerId !== null && entry.userId === viewerId) {
      mine.set(entry.clubId, {
        role: entry.role as ClubRole,
        joinedAt: isoOf(entry.joinedAt),
      });
    }
  }

  for (const thread of threads) {
    discussionCounts.set(
      thread.clubId,
      (discussionCounts.get(thread.clubId) ?? 0) + 1,
    );
  }

  const ownerUsers = await usersByIds(
    db,
    [...owners.values()].map((owner) => owner.userId),
  );

  /**
   * The current reads, resolved through the story visibility rule rather than
   * read straight off the table: a club pointed at an unlisted story must not
   * publish its title to people who cannot open it.
   */
  const storyIds = rows
    .map((row) => row.currentStoryId)
    .filter((id): id is string => id !== null);
  const stories = await getStoriesByIds(storyIds, viewerId);

  return rows.map((row) => {
    const ownerId = owners.get(row.id)?.userId;

    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      memberCount: memberCounts.get(row.id) ?? 0,
      discussionCount: discussionCounts.get(row.id) ?? 0,
      createdAt: isoOf(row.createdAt),
      updatedAt: isoOf(row.updatedAt),
      owner: ownerId ? ownerUsers.get(ownerId) ?? null : null,
      currentStory:
        row.currentStoryId === null
          ? null
          : stories.get(row.currentStoryId) ?? null,
      membership: mine.get(row.id) ?? null,
    };
  });
}

function clubsBase() {
  return db.orm.clubs.BookClub.select(
    "id",
    "slug",
    "name",
    "description",
    "creatorId",
    "currentStoryId",
    "createdAt",
    "updatedAt",
  );
}

/* Reads ------------------------------------------------------------------ */

export async function listClubs(
  query: ClubQuery,
  viewerId: string | null,
): Promise<Page<Club>> {
  let collection = clubsBase();

  if (query.search) {
    const term = `%${query.search}%`;
    collection = collection.where((club) =>
      or(club.name.ilike(term), club.description.ilike(term)),
    );
  }

  /**
   * "My clubs" is a membership predicate rather than a second query, so it
   * composes with search and paginates like every other filter. An anonymous
   * caller belongs to nothing, so the flag is dropped rather than answered
   * with an empty page -- there is no caller to have clubs.
   */
  if (query.mine && viewerId !== null) {
    const memberOf = await db.orm.clubs.ClubMembership.select("clubId")
      .where((entry) => entry.userId.eq(viewerId))
      .all();

    const ids = memberOf.map((entry) => entry.clubId);
    if (ids.length === 0) {
      return {
        items: [],
        page: query.page,
        limit: query.limit,
        total: 0,
        totalPages: 0,
        hasMore: false,
      };
    }

    collection = collection.where((club) => club.id.in(ids));
  }

  const totals = await collection.aggregate((aggregate) => ({
    total: aggregate.count(),
  }));

  /**
   * `members` sorts in JS, uniquely among the three: the member count lives in
   * a child table, and the grouped collection cannot order by an aggregate
   * (see the Postgres query guide). The set is one page of clubs, so sorting
   * the hydrated rows is cheaper than the SQL that would avoid it -- but it
   * does mean the page is ordered within itself, so the whole filtered set is
   * hydrated for that sort alone.
   */
  const paginate = query.sort !== "members";

  let sorted = collection;
  if (query.sort === "newest") {
    sorted = collection.orderBy([
      (club) => club.createdAt.desc(),
      (club) => club.id.desc(),
    ]);
  } else if (query.sort === "name") {
    sorted = collection.orderBy([
      (club) => club.name.asc(),
      (club) => club.id.asc(),
    ]);
  } else {
    sorted = collection.orderBy((club) => club.id.asc());
  }

  const rows = paginate
    ? await sorted
        .offset((query.page - 1) * query.limit)
        .limit(query.limit)
        .all()
    : await sorted.all();

  let items = await hydrate(rows as ClubRow[], viewerId);

  if (!paginate) {
    items = items
      .sort((a, b) => b.memberCount - a.memberCount || a.id.localeCompare(b.id))
      .slice((query.page - 1) * query.limit, query.page * query.limit);
  }

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

/**
 * One club by slug or by id.
 *
 * Both work for the reason `services/stories.ts` gives: the app addresses
 * clubs by slug, while everything the API itself returns carries ids. The id
 * branch is only attempted for something shaped like a UUID -- comparing an
 * arbitrary string against a `uuid` column is a Postgres error, not a miss.
 */
async function findClubRow(slugOrId: string): Promise<ClubRow | null> {
  const bySlug = await clubsBase()
    .where((club) => club.slug.eq(slugOrId))
    .first();
  if (bySlug) return bySlug as ClubRow;

  if (!UUID.test(slugOrId)) return null;

  const byId = await clubsBase().where((club) => club.id.eq(slugOrId)).first();
  return (byId as ClubRow | undefined) ?? null;
}

export async function getClub(
  slugOrId: string,
  viewerId: string | null,
): Promise<ClubDetail> {
  const row = await findClubRow(slugOrId);
  if (!row) throw HttpError.notFound(CLUB_NOT_FOUND);

  const [club] = await hydrate([row], viewerId);
  if (!club) throw HttpError.notFound(CLUB_NOT_FOUND);

  return { ...club, moderators: await listModerators(row.id) };
}

async function listModerators(clubId: string): Promise<ClubMember[]> {
  const rows = await db.orm.clubs.ClubMembership.select(
    "userId",
    "role",
    "joinedAt",
  )
    .where((entry) => entry.clubId.eq(clubId))
    .where((entry) => or(entry.role.eq("OWNER"), entry.role.eq("ADMIN")))
    .orderBy((entry) => entry.joinedAt.asc())
    .all();

  const users = await usersByIds(db, rows.map((row) => row.userId));

  return rows
    .map((row) => {
      const user = users.get(row.userId);
      if (!user) return null;

      return {
        user,
        role: row.role as ClubRole,
        joinedAt: isoOf(row.joinedAt),
      };
    })
    .filter((member): member is ClubMember => member !== null);
}

/** The full membership roll, for the club's people list. */
export async function listMembers(
  slugOrId: string,
  page: number,
  limit: number,
): Promise<Page<ClubMember>> {
  const club = await findClubRow(slugOrId);
  if (!club) throw HttpError.notFound(CLUB_NOT_FOUND);

  const collection = db.orm.clubs.ClubMembership.select(
    "userId",
    "role",
    "joinedAt",
  ).where((entry) => entry.clubId.eq(club.id));

  const totals = await collection.aggregate((aggregate) => ({
    total: aggregate.count(),
  }));

  const rows = await collection
    .orderBy([(entry) => entry.joinedAt.asc(), (entry) => entry.userId.asc()])
    .offset((page - 1) * limit)
    .limit(limit)
    .all();

  const users = await usersByIds(db, rows.map((row) => row.userId));

  const items = rows
    .map((row) => {
      const user = users.get(row.userId);
      if (!user) return null;

      return { user, role: row.role as ClubRole, joinedAt: isoOf(row.joinedAt) };
    })
    .filter((member): member is ClubMember => member !== null);

  const total = totals.total;

  return {
    items,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
    hasMore: page * limit < total,
  };
}

/* Authorisation ---------------------------------------------------------- */

interface MembershipRow {
  id: string;
  clubId: string;
  userId: string;
  role: ClubRole;
}

async function findMembership(
  client: Orm,
  clubId: string,
  userId: string,
): Promise<MembershipRow | null> {
  const row = await client.orm.clubs.ClubMembership.select(
    "id",
    "clubId",
    "userId",
    "role",
  )
    .where((entry) => entry.clubId.eq(clubId))
    .where((entry) => entry.userId.eq(userId))
    .first();

  return row ? ({ ...row, role: row.role as ClubRole } as MembershipRow) : null;
}

/**
 * The club `slugOrId` names, once the caller is established as holding one of
 * `allowed`.
 *
 * 404 for a club that does not exist, 403 for one that does and is not the
 * caller's to touch -- the distinction `services/authoring.ts` draws, for the
 * same reason: a club's existence is public, its administration is not.
 */
async function requireRole(
  client: Orm,
  slugOrId: string,
  userId: string,
  allowed: readonly ClubRole[],
  message: string,
): Promise<{ club: ClubRow; membership: MembershipRow }> {
  const club = await findClubRow(slugOrId);
  if (!club) throw HttpError.notFound(CLUB_NOT_FOUND);

  const membership = await findMembership(client, club.id, userId);
  if (!membership || !allowed.includes(membership.role)) {
    throw HttpError.forbidden(message);
  }

  return { club, membership };
}

/**
 * Refuses to strip the club's last owner.
 *
 * Called by leave, role change and member removal alike, inside whichever
 * transaction is about to do the stripping -- a check outside the transaction
 * could pass for two owners leaving at once and leave the club with none.
 */
async function assertNotLastOwner(
  tx: Tx,
  clubId: string,
  userId: string,
): Promise<void> {
  const owners = await tx.orm.clubs.ClubMembership.select("userId")
    .where((entry) => entry.clubId.eq(clubId))
    .where((entry) => entry.role.eq("OWNER"))
    .all();

  const isOnlyOwner =
    owners.length <= 1 && owners.some((owner) => owner.userId === userId);

  if (isOnlyOwner) {
    throw HttpError.conflict(
      "You are the club's only owner. Make another member an owner before you go.",
    );
  }
}

/* Writes ----------------------------------------------------------------- */

export interface ClubInput {
  name: string;
  description?: string | null | undefined;
}

export async function createClub(
  userId: string,
  input: ClubInput,
): Promise<ClubDetail> {
  const timestamp = now();

  const clubId = await db.transaction(async (tx) => {
    const slug = await uniqueSlug(input.name, async (candidate) => {
      const taken = await tx.orm.clubs.BookClub.select("id")
        .where((club) => club.slug.eq(candidate))
        .first();
      return taken !== undefined && taken !== null;
    });

    const club = await tx.orm.clubs.BookClub.select("id").create({
      name: input.name,
      slug,
      description: input.description ?? null,
      creatorId: userId,
      currentStoryId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    // The creator's OWNER membership is what makes them the owner; the
    // `creatorId` column alone grants nothing. Written in the same
    // transaction so an ownerless club is never observable.
    await tx.orm.clubs.ClubMembership.create({
      clubId: club.id,
      userId,
      role: "OWNER",
      joinedAt: timestamp,
    });

    return club.id;
  });

  return getClub(clubId, userId);
}

export async function updateClub(
  userId: string,
  slugOrId: string,
  input: Partial<ClubInput>,
): Promise<ClubDetail> {
  const timestamp = now();

  const clubId = await db.transaction(async (tx) => {
    const { club } = await requireRole(
      tx,
      slugOrId,
      userId,
      ["OWNER", "ADMIN"],
      "Only the club's owner or an admin can change it.",
    );

    const changes: Record<string, unknown> = { updatedAt: timestamp };

    if (input.name !== undefined && input.name !== club.name) {
      changes["name"] = input.name;
    }
    if (input.description !== undefined) {
      changes["description"] = input.description ?? null;
    }

    /**
     * The slug is deliberately not re-derived on a rename. Members link to a
     * club and those links have to keep working; `content.Story` makes the
     * same trade once a story is published.
     */
    await tx.orm.clubs.BookClub.where((row) => row.id.eq(club.id)).update(
      changes,
    );

    return club.id;
  });

  return getClub(clubId, userId);
}

export async function deleteClub(
  userId: string,
  slugOrId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const { club } = await requireRole(
      tx,
      slugOrId,
      userId,
      ["OWNER", "ADMIN"],
      "Only the club's owner or an admin can delete it.",
    );

    /**
     * Replies before threads: a reply's `parentId` points at another row in
     * this same table, so deleting threads first would breach that foreign
     * key. Both before the memberships, which they do not reference but which
     * the club does.
     */
    await tx.orm.clubs.ClubDiscussion.where((row) => row.clubId.eq(club.id))
      .where((row) => row.parentId.isNotNull())
      .delete();
    await tx.orm.clubs.ClubDiscussion.where((row) =>
      row.clubId.eq(club.id),
    ).delete();
    await tx.orm.clubs.ClubMembership.where((entry) =>
      entry.clubId.eq(club.id),
    ).delete();
    await tx.orm.clubs.BookClub.where((row) => row.id.eq(club.id)).delete();
  });
}

/**
 * Joins the club, or reports the membership the caller already has.
 *
 * Idempotent by contract: the second call is a success returning the same
 * membership, not a 409. Joining is a button a reader can double-click, and
 * an error there would be a lie about the outcome -- they are in the club.
 */
export async function joinClub(
  userId: string,
  slugOrId: string,
): Promise<ClubMembership> {
  const club = await findClubRow(slugOrId);
  if (!club) throw HttpError.notFound(CLUB_NOT_FOUND);

  const existing = await findMembership(db, club.id, userId);
  if (existing) {
    const row = await db.orm.clubs.ClubMembership.select("role", "joinedAt")
      .where((entry) => entry.id.eq(existing.id))
      .first();

    return {
      role: (row?.role ?? existing.role) as ClubRole,
      joinedAt: isoOf(row?.joinedAt),
    };
  }

  const timestamp = now();

  try {
    const created = await db.orm.clubs.ClubMembership.select(
      "role",
      "joinedAt",
    ).create({
      clubId: club.id,
      userId,
      role: "MEMBER",
      joinedAt: timestamp,
    });

    return {
      role: created.role as ClubRole,
      joinedAt: isoOf(created.joinedAt),
    };
  } catch (error) {
    // Two simultaneous joins: the unique index is the real arbiter, and the
    // loser is still a member, so answer as the pre-check above would have.
    if (!isUniqueViolation(error)) throw error;

    const raced = await findMembership(db, club.id, userId);
    if (!raced) throw error;

    return { role: raced.role, joinedAt: isoOf(timestamp) };
  }
}

export async function leaveClub(
  userId: string,
  slugOrId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const club = await findClubRow(slugOrId);
    if (!club) throw HttpError.notFound(CLUB_NOT_FOUND);

    const membership = await findMembership(tx, club.id, userId);
    // Leaving a club you are not in is already true, so it is not an error.
    if (!membership) return;

    if (membership.role === "OWNER") {
      await assertNotLastOwner(tx, club.id, userId);
    }

    await tx.orm.clubs.ClubMembership.where((entry) =>
      entry.id.eq(membership.id),
    ).delete();
  });
}

/**
 * Changes a member's role.
 *
 * `OWNER` only, because this is how ownership transfers: promoting another
 * member to `OWNER` and then demoting or removing yourself is the supported
 * hand-over, and an admin who could do it would be able to promote themselves.
 */
export async function setMemberRole(
  userId: string,
  slugOrId: string,
  targetUserId: string,
  role: ClubRole,
): Promise<ClubMember> {
  const memberId = await db.transaction(async (tx) => {
    const { club } = await requireRole(
      tx,
      slugOrId,
      userId,
      ["OWNER"],
      "Only the club's owner can change roles.",
    );

    const target = await findMembership(tx, club.id, targetUserId);
    if (!target) throw HttpError.notFound("That person is not in this club.");

    if (target.role === role) return target.id;

    // Demoting yourself is the second half of a hand-over, so it is allowed --
    // but only once somebody else holds OWNER.
    if (target.role === "OWNER" && role !== "OWNER") {
      await assertNotLastOwner(tx, club.id, targetUserId);
    }

    await tx.orm.clubs.ClubMembership.where((entry) =>
      entry.id.eq(target.id),
    ).update({ role });

    return target.id;
  });

  const row = await db.orm.clubs.ClubMembership.select(
    "userId",
    "role",
    "joinedAt",
  )
    .where((entry) => entry.id.eq(memberId))
    .first();

  if (!row) throw HttpError.notFound("That person is not in this club.");

  const users = await usersByIds(db, [row.userId]);
  const user = users.get(row.userId);
  if (!user) throw HttpError.notFound("That person is not in this club.");

  return { user, role: row.role as ClubRole, joinedAt: isoOf(row.joinedAt) };
}

/** Removes somebody else from the club. Owners and admins only. */
export async function removeMember(
  userId: string,
  slugOrId: string,
  targetUserId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const { membership: caller, club } = await requireRole(
      tx,
      slugOrId,
      userId,
      ["OWNER", "ADMIN"],
      "Only the club's owner or an admin can remove members.",
    );

    const target = await findMembership(tx, club.id, targetUserId);
    if (!target) return;

    // An admin may not remove a peer or the owner; only an owner outranks
    // them. Without this, any admin could empty the club's leadership.
    if (caller.role === "ADMIN" && target.role !== "MEMBER") {
      throw HttpError.forbidden("Only the club's owner can remove an admin.");
    }

    if (target.role === "OWNER") {
      await assertNotLastOwner(tx, club.id, targetUserId);
    }

    await tx.orm.clubs.ClubMembership.where((entry) =>
      entry.id.eq(target.id),
    ).delete();
  });
}

/**
 * Points the club at the story it is reading, or clears it with a null.
 *
 * The story is resolved through the visibility rule with the *caller* as
 * viewer, so an owner may set their own unlisted draft as the current read --
 * and everyone else will see `currentStory: null` until it is published,
 * because `hydrate` resolves it per viewer too.
 */
export async function setCurrentRead(
  userId: string,
  slugOrId: string,
  storyId: string | null,
): Promise<ClubDetail> {
  const timestamp = now();

  const clubId = await db.transaction(async (tx) => {
    const { club } = await requireRole(
      tx,
      slugOrId,
      userId,
      ["OWNER", "ADMIN"],
      "Only the club's owner or an admin can set the current read.",
    );

    if (storyId !== null) {
      const stories = await getStoriesByIds([storyId], userId);
      if (!stories.has(storyId)) {
        throw HttpError.notFound("That story could not be found.");
      }
    }

    await tx.orm.clubs.BookClub.where((row) => row.id.eq(club.id)).update({
      currentStoryId: storyId,
      updatedAt: timestamp,
    });

    return club.id;
  });

  return getClub(clubId, userId);
}

/* Discussions ------------------------------------------------------------ */

export interface DiscussionQuery {
  /**
   * Null lists the club's top-level threads; a thread id lists that thread's
   * replies. Undefined means the same as null -- the default view.
   */
  parentId?: string | undefined;
  page: number;
  limit: number;
}

export async function listDiscussions(
  slugOrId: string,
  query: DiscussionQuery,
): Promise<Page<Discussion>> {
  const club = await findClubRow(slugOrId);
  if (!club) throw HttpError.notFound(CLUB_NOT_FOUND);

  const parentId = query.parentId;

  let collection = db.orm.clubs.ClubDiscussion.select(
    "id",
    "clubId",
    "userId",
    "body",
    "parentId",
    "createdAt",
    "updatedAt",
  ).where((row) => row.clubId.eq(club.id));

  collection =
    parentId === undefined
      ? collection.where((row) => row.parentId.isNull())
      : collection.where((row) => row.parentId.eq(parentId));

  const totals = await collection.aggregate((aggregate) => ({
    total: aggregate.count(),
  }));

  /**
   * Threads newest first -- the club page leads with what is being replied to
   * today -- and replies oldest first, because a thread reads as a
   * conversation in the order it happened.
   */
  const rows = await collection
    .orderBy(
      parentId === undefined
        ? [(row) => row.createdAt.desc(), (row) => row.id.desc()]
        : [(row) => row.createdAt.asc(), (row) => row.id.asc()],
    )
    .offset((query.page - 1) * query.limit)
    .limit(query.limit)
    .all();

  const items = await hydrateDiscussions(rows, parentId === undefined);
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

interface DiscussionRow {
  id: string;
  clubId: string;
  userId: string;
  body: string;
  parentId: string | null;
  createdAt: unknown;
  updatedAt: unknown;
}

async function hydrateDiscussions(
  rows: DiscussionRow[],
  withReplyCounts: boolean,
): Promise<Discussion[]> {
  if (rows.length === 0) return [];

  const users = await usersByIds(db, rows.map((row) => row.userId));

  const replyCounts = new Map<string, number>();
  if (withReplyCounts) {
    // One query for the whole page's replies rather than one per thread.
    const replies = await db.orm.clubs.ClubDiscussion.select("parentId")
      .where((row) => row.parentId.in(rows.map((thread) => thread.id)))
      .all();

    for (const reply of replies) {
      if (reply.parentId === null) continue;
      replyCounts.set(reply.parentId, (replyCounts.get(reply.parentId) ?? 0) + 1);
    }
  }

  return rows
    .map((row) => {
      // A discussion whose author was deleted drops out rather than failing
      // the whole list, the way `services/library.ts` drops a vanished book.
      const user = users.get(row.userId);
      if (!user) return null;

      return {
        id: row.id,
        clubId: row.clubId,
        parentId: row.parentId,
        body: row.body,
        createdAt: isoOf(row.createdAt),
        updatedAt: isoOf(row.updatedAt),
        replyCount: replyCounts.get(row.id) ?? 0,
        user,
      };
    })
    .filter((item): item is Discussion => item !== null);
}

/**
 * Posts a thread, or a reply when `parentId` is given.
 *
 * Members only -- a club's threads are the thing membership is for. The role
 * does not matter beyond that: every member may post.
 */
export async function createDiscussion(
  userId: string,
  slugOrId: string,
  input: { body: string; parentId?: string | undefined },
): Promise<Discussion> {
  const timestamp = now();

  const discussionId = await db.transaction(async (tx) => {
    const { club } = await requireRole(
      tx,
      slugOrId,
      userId,
      CLUB_ROLES,
      "Join the club to post in it.",
    );

    let parentId: string | null = null;

    if (input.parentId !== undefined) {
      const parent = await tx.orm.clubs.ClubDiscussion.select(
        "id",
        "clubId",
        "parentId",
      )
        .where((row) => row.id.eq(input.parentId as string))
        .first();

      if (!parent || parent.clubId !== club.id) {
        throw HttpError.notFound(DISCUSSION_NOT_FOUND);
      }

      // Replies are one level deep, so replying to a reply attaches to its
      // thread instead of nesting. The alternative is a tree the UI has no
      // way to render.
      parentId = parent.parentId ?? parent.id;
    }

    const created = await tx.orm.clubs.ClubDiscussion.select("id").create({
      clubId: club.id,
      userId,
      body: input.body,
      parentId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    return created.id;
  });

  const row = await db.orm.clubs.ClubDiscussion.select(
    "id",
    "clubId",
    "userId",
    "body",
    "parentId",
    "createdAt",
    "updatedAt",
  )
    .where((item) => item.id.eq(discussionId))
    .first();

  if (!row) throw HttpError.notFound(DISCUSSION_NOT_FOUND);

  const [discussion] = await hydrateDiscussions([row as DiscussionRow], true);
  if (!discussion) throw HttpError.notFound(DISCUSSION_NOT_FOUND);

  return discussion;
}

/**
 * Deletes a thread or reply. Its author, or the club's owner or an admin:
 * authors retract their own words, moderators remove somebody else's.
 */
export async function deleteDiscussion(
  userId: string,
  discussionId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await tx.orm.clubs.ClubDiscussion.select(
      "id",
      "clubId",
      "userId",
    )
      .where((item) => item.id.eq(discussionId))
      .first();

    if (!row) throw HttpError.notFound(DISCUSSION_NOT_FOUND);

    if (row.userId !== userId) {
      const membership = await findMembership(tx, row.clubId, userId);
      const moderates =
        membership !== null &&
        (membership.role === "OWNER" || membership.role === "ADMIN");

      if (!moderates) {
        throw HttpError.forbidden("That post is not yours to delete.");
      }
    }

    // Replies first, so deleting a thread does not breach the self-referencing
    // foreign key. Deleting a reply matches nothing here, which is fine.
    await tx.orm.clubs.ClubDiscussion.where((item) =>
      item.parentId.eq(row.id),
    ).delete();
    await tx.orm.clubs.ClubDiscussion.where((item) =>
      item.id.eq(row.id),
    ).delete();
  });
}

/** Postgres reports a unique-constraint breach as SQLSTATE 23505. */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  const candidate = error as { code?: unknown; sqlState?: unknown; cause?: unknown };
  if (candidate.code === "23505" || candidate.sqlState === "23505") return true;

  return candidate.cause !== undefined && isUniqueViolation(candidate.cause);
}
