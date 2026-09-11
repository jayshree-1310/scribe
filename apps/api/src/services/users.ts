/**
 * Public profiles and the follow graph.
 *
 * The profile returned here is a *different shape* from `services/account.ts`,
 * deliberately. That module serves the signed-in reader their own account and
 * carries `email`, `emailVerified` and `hasPassword`; none of those are
 * anybody else's to know, so this module names its own fields and shares
 * nothing with it but the table. Both write the response out field by field
 * rather than spreading the row, which is what makes adding a column to
 * `auth.User` safe: a new secret cannot start leaking through a profile
 * nobody re-read.
 *
 * Counts are computed from `engagement.Follow` on every read rather than kept
 * in a column. Unlike `Story.ratingAverage` -- denormalised because
 * `sort=rating` orders in SQL over the story table -- nothing sorts or filters
 * on a follower count, so a column would buy nothing and could drift.
 *
 * Story visibility is not re-implemented here. `listUserStories` delegates to
 * `listStories` and the header count goes through `countVisibleStoriesBy`, so
 * the one rule that hides a draft lives in `services/stories.ts` alone.
 *
 * Every function takes the caller's id explicitly -- the routes resolve it
 * once through `middleware/current-user.ts` -- so nothing here reaches for
 * ambient request state.
 */

import { Temporal } from "temporal-polyfill";
import { db } from "../prisma/db.js";
import { HttpError } from "../lib/http-error.js";
import {
  countVisibleStoriesBy,
  listStories,
  toIso,
  type Page,
  type Story,
} from "./stories.js";

/* Shapes returned to the client ----------------------------------------- */

/**
 * The four-field summary every list endpoint on Scribe returns for a person --
 * the same one `services/clubs.ts`, `services/channels.ts` and
 * `services/engagement.ts` agreed on. Never the whole user row.
 */
export interface ProfileUser {
  id: string;
  username: string;
  /** Absent for password signups, where the UI falls back to the username. */
  displayName: string | null;
  avatarUrl: string | null;
}

export interface PublicProfile extends ProfileUser {
  bio: string | null;
  isAuthor: boolean;
  readerLevel: number;
  authorLevel: number;
  readingStreak: number;
  joinedAt: string;
  /**
   * Stories the caller may see by this author -- the published ones for a
   * stranger, drafts included when an author is looking at their own profile.
   * The same rule `GET /api/users/:username/stories` pages through.
   */
  storyCount: number;
  followerCount: number;
  followingCount: number;
  /** Whether the caller follows this person. False when anonymous. */
  isFollowing: boolean;
  /** Whether this profile is the caller's own, so the UI can hide Follow. */
  isMe: boolean;
}

/** One edge of the follow graph, shaped like `ClubMember`. */
export interface FollowEntry {
  user: ProfileUser;
  followedAt: string;
  /**
   * Whether the *caller* follows this person -- what a "Follow back" button
   * needs. Always false for the caller's own row and for an anonymous caller.
   */
  isFollowing: boolean;
}

/** What a follow write leaves behind, so the button can redraw without a refetch. */
export interface FollowState {
  following: boolean;
  followerCount: number;
}

export const MAX_PAGE_SIZE = 48;

const USER_NOT_FOUND = "That profile could not be found.";

/* Helpers ---------------------------------------------------------------- */

/** `now()` in the spelling the timestamp codec writes. */
function now(): Temporal.Instant {
  return Temporal.Now.instant();
}

/** These columns are never null; the epoch fallback keeps one bad row local. */
function isoOf(value: unknown): string {
  return toIso(value) ?? new Date(0).toISOString();
}

function emptyPage<T>(page: number, limit: number): Page<T> {
  return { items: [], page, limit, total: 0, totalPages: 0, hasMore: false };
}

function toPage<T>(items: T[], page: number, limit: number, total: number): Page<T> {
  return {
    items,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
    hasMore: page * limit < total,
  };
}

/**
 * Usernames are stored lower-case (`lib/auth-schemas.ts` explains why), so a
 * link typed with capitals has to find the same person. Normalised here rather
 * than in the route schema: the route's job is to bound the string, and an
 * unknown username is a 404 rather than a 400 whatever its shape.
 */
function normalise(username: string): string {
  return username.trim().toLowerCase();
}

interface UserRow {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  isAuthor: boolean;
  readerLevel: number;
  authorLevel: number;
  readingStreak: number;
  createdAt: unknown;
}

/**
 * Exactly the columns a public profile is allowed to carry. `email`,
 * `passwordHash`, `googleId`, `emailVerified` and `streakLastReadAt` are
 * absent by construction -- they are never selected, so no later edit to the
 * mapping below can expose one.
 */
const PUBLIC_COLUMNS = [
  "id",
  "username",
  "displayName",
  "avatarUrl",
  "bio",
  "isAuthor",
  "readerLevel",
  "authorLevel",
  "readingStreak",
  "createdAt",
] as const;

function toProfileUser(row: {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}): ProfileUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
  };
}

/** The user `username` names, or a 404. */
async function findByUsername(username: string): Promise<UserRow> {
  const row = await db.orm.auth.User.select(...PUBLIC_COLUMNS)
    .where((user) => user.username.eq(normalise(username)))
    .first();

  if (!row) throw HttpError.notFound(USER_NOT_FOUND);

  return row as UserRow;
}

/** The user summaries for a set of ids, in one query rather than one per row. */
async function usersByIds(ids: string[]): Promise<Map<string, ProfileUser>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();

  const rows = await db.orm.auth.User.select(
    "id",
    "username",
    "displayName",
    "avatarUrl",
  )
    .where((user) => user.id.in(unique))
    .all();

  return new Map(rows.map((row) => [row.id, toProfileUser(row)]));
}

/**
 * Which of `userIds` the caller already follows, in one query for the whole
 * page rather than one per row.
 */
async function followedBy(
  viewerId: string | null,
  userIds: string[],
): Promise<Set<string>> {
  if (viewerId === null || userIds.length === 0) return new Set();

  const rows = await db.orm.engagement.Follow.select("followingId")
    .where((follow) => follow.followerId.eq(viewerId))
    .where((follow) => follow.followingId.in([...new Set(userIds)]))
    .all();

  return new Set(rows.map((row) => row.followingId));
}

async function countFollowers(userId: string): Promise<number> {
  const totals = await db.orm.engagement.Follow.where((follow) =>
    follow.followingId.eq(userId),
  ).aggregate((aggregate) => ({ total: aggregate.count() }));

  return totals.total;
}

async function countFollowing(userId: string): Promise<number> {
  const totals = await db.orm.engagement.Follow.where((follow) =>
    follow.followerId.eq(userId),
  ).aggregate((aggregate) => ({ total: aggregate.count() }));

  return totals.total;
}

/* Reads ------------------------------------------------------------------ */

/** One reader's public profile. Open -- no sign-in required. */
export async function getPublicProfile(
  username: string,
  viewerId: string | null,
): Promise<PublicProfile> {
  const row = await findByUsername(username);

  const [storyCount, followerCount, followingCount, following] =
    await Promise.all([
      countVisibleStoriesBy(row.id, viewerId),
      countFollowers(row.id),
      countFollowing(row.id),
      followedBy(viewerId, [row.id]),
    ]);

  return {
    ...toProfileUser(row),
    bio: row.bio,
    isAuthor: row.isAuthor,
    readerLevel: row.readerLevel,
    authorLevel: row.authorLevel,
    readingStreak: row.readingStreak,
    joinedAt: isoOf(row.createdAt),
    storyCount,
    followerCount,
    followingCount,
    isFollowing: following.has(row.id),
    isMe: viewerId !== null && viewerId === row.id,
  };
}

/**
 * One author's stories, newest first.
 *
 * Delegated to `listStories` rather than queried here: that function owns the
 * draft rule, so an author asking for their own profile gets their drafts and
 * everybody else asking for the same page does not.
 */
export async function listUserStories(
  username: string,
  query: { page: number; limit: number },
  viewerId: string | null,
): Promise<Page<Story>> {
  const row = await findByUsername(username);

  return listStories(
    {
      authorId: row.id,
      sort: "newest",
      page: query.page,
      limit: query.limit,
    },
    viewerId,
  );
}

type FollowDirection = "followers" | "following";

/**
 * One side of somebody's follow graph, newest first.
 *
 * `createdAt` with `id` as the tie-breaker, the same rule every paginated list
 * on Scribe follows, so two follows written in the same millisecond cannot
 * swap places between pages and show the same person twice.
 */
async function listFollowEdges(
  username: string,
  direction: FollowDirection,
  query: { page: number; limit: number },
  viewerId: string | null,
): Promise<Page<FollowEntry>> {
  const row = await findByUsername(username);

  const collection =
    direction === "followers"
      ? db.orm.engagement.Follow.select("followerId", "createdAt", "id").where(
          (follow) => follow.followingId.eq(row.id),
        )
      : db.orm.engagement.Follow.select("followingId", "createdAt", "id").where(
          (follow) => follow.followerId.eq(row.id),
        );

  const totals = await collection.aggregate((aggregate) => ({
    total: aggregate.count(),
  }));

  if (totals.total === 0) return emptyPage(query.page, query.limit);

  const rows = await collection
    .orderBy([(follow) => follow.createdAt.desc(), (follow) => follow.id.desc()])
    .offset((query.page - 1) * query.limit)
    .limit(query.limit)
    .all();

  const otherIds = rows.map((edge) =>
    direction === "followers"
      ? (edge as { followerId: string }).followerId
      : (edge as { followingId: string }).followingId,
  );

  const [users, mine] = await Promise.all([
    usersByIds(otherIds),
    followedBy(viewerId, otherIds),
  ]);

  const items = rows
    .map((edge, index) => {
      // A vanished account drops out rather than failing the whole page, the
      // way `services/engagement.ts` drops a comment whose author is gone.
      const userId = otherIds[index] as string;
      const user = users.get(userId);
      if (!user) return null;

      return {
        user,
        followedAt: isoOf((edge as { createdAt: unknown }).createdAt),
        isFollowing: mine.has(userId),
      };
    })
    .filter((entry): entry is FollowEntry => entry !== null);

  return toPage(items, query.page, query.limit, totals.total);
}

export function listFollowers(
  username: string,
  query: { page: number; limit: number },
  viewerId: string | null,
): Promise<Page<FollowEntry>> {
  return listFollowEdges(username, "followers", query, viewerId);
}

export function listFollowing(
  username: string,
  query: { page: number; limit: number },
  viewerId: string | null,
): Promise<Page<FollowEntry>> {
  return listFollowEdges(username, "following", query, viewerId);
}

/* Writes ----------------------------------------------------------------- */

/**
 * Follows somebody. Idempotent: following twice leaves one row and answers the
 * same state, so a double-tapped button is not an error the UI has to explain.
 *
 * Following yourself is refused rather than silently ignored. The contract
 * cannot express the check constraint that would enforce it, so this is the
 * only place the rule exists -- and a test pins it.
 */
export async function followUser(
  followerId: string,
  username: string,
): Promise<FollowState> {
  const target = await findByUsername(username);

  if (target.id === followerId) {
    throw HttpError.badRequest("You cannot follow yourself.");
  }

  await db.transaction(async (tx) => {
    const existing = await tx.orm.engagement.Follow.select("id")
      .where((follow) => follow.followerId.eq(followerId))
      .where((follow) => follow.followingId.eq(target.id))
      .first();

    if (existing) return;

    await tx.orm.engagement.Follow.create({
      followerId,
      followingId: target.id,
      createdAt: now(),
    });
  });

  return { following: true, followerCount: await countFollowers(target.id) };
}

/** Unfollows somebody. Idempotent: unfollowing a stranger is a no-op, not a 404. */
export async function unfollowUser(
  followerId: string,
  username: string,
): Promise<FollowState> {
  const target = await findByUsername(username);

  await db.orm.engagement.Follow.where((follow) =>
    follow.followerId.eq(followerId),
  )
    .where((follow) => follow.followingId.eq(target.id))
    .delete();

  return { following: false, followerCount: await countFollowers(target.id) };
}
