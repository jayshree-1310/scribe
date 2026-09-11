/**
 * Broadcast channels: an author's one-way line to readers who opted in.
 *
 * Simpler than clubs by design. A channel has exactly one privileged user --
 * `BroadcastChannel.authorId` -- and no role table, so every write goes through
 * `ownedChannel`, which is the only place ownership is decided. Subscribers
 * read; they never write anything but their own subscription.
 *
 * Every function takes the caller's id explicitly -- the routes resolve it once
 * through `middleware/current-user.ts` -- so nothing here reaches for ambient
 * request state.
 */

import { Temporal } from "temporal-polyfill";
import { or } from "@prisma/orm-postgres/orm-client";
import { db } from "../prisma/db.js";
import { HttpError } from "../lib/http-error.js";
import { uniqueSlug } from "../lib/slug.js";
import { toIso } from "./stories.js";

/**
 * The transaction context, derived from `db.transaction` rather than imported
 * for the reason `services/authoring.ts` gives: the type is not re-exported
 * from the runtime entry point.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type Orm = Pick<Tx, "orm"> | typeof db;

/* Shapes returned to the client ----------------------------------------- */

export interface ChannelAuthor {
  id: string;
  username: string;
  /** Absent for password signups, where the UI falls back to the username. */
  displayName: string | null;
  avatarUrl: string | null;
}

export interface Channel {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  subscriberCount: number;
  postCount: number;
  createdAt: string;
  updatedAt: string;
  author: ChannelAuthor;
  /** The caller's subscription state; always false when anonymous. */
  subscribed: boolean;
}

export interface ChannelPost {
  id: string;
  channelId: string;
  title: string;
  content: string;
  postedAt: string;
  updatedAt: string;
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

export const CHANNEL_SORTS = ["subscribers", "newest", "name"] as const;

export type ChannelSort = (typeof CHANNEL_SORTS)[number];

export interface ChannelQuery {
  search?: string | undefined;
  /** Only channels the caller owns. Ignored for an anonymous caller. */
  mine?: boolean | undefined;
  /** Only channels the caller subscribes to. Ignored when anonymous. */
  subscribed?: boolean | undefined;
  sort: ChannelSort;
  page: number;
  limit: number;
}

export const CHANNEL_NOT_FOUND = "That channel could not be found.";

const POST_NOT_FOUND = "That post could not be found.";

/* Helpers ---------------------------------------------------------------- */

/** `now()` in the spelling the timestamp codec writes. */
function now(): Temporal.Instant {
  return Temporal.Now.instant();
}

/** These columns are never null; the epoch fallback keeps one bad row local. */
function isoOf(value: unknown): string {
  return toIso(value) ?? new Date(0).toISOString();
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ChannelRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  authorId: string;
  createdAt: unknown;
  updatedAt: unknown;
}

function channelsBase(client: Orm = db) {
  return client.orm.channels.BroadcastChannel.select(
    "id",
    "slug",
    "name",
    "description",
    "authorId",
    "createdAt",
    "updatedAt",
  );
}

/**
 * Attaches the author, the two counts and the caller's subscription state.
 *
 * Gathered per set of channels rather than per channel, so a grid of 12 costs
 * a fixed handful of queries instead of 12 times as many.
 */
async function hydrate(
  rows: ChannelRow[],
  viewerId: string | null,
): Promise<Channel[]> {
  if (rows.length === 0) return [];

  const channelIds = rows.map((row) => row.id);

  const authorIds = [...new Set(rows.map((row) => row.authorId))];
  const authorRows = await db.orm.auth.User.select(
    "id",
    "username",
    "displayName",
    "avatarUrl",
  )
    .where((user) => user.id.in(authorIds))
    .all();

  const authors = new Map(authorRows.map((row) => [row.id, row]));

  const subscribers = await db.orm.channels.ChannelSubscriber.select(
    "channelId",
    "userId",
  )
    .where((row) => row.channelId.in(channelIds))
    .all();

  const posts = await db.orm.channels.ChannelPost.select("channelId")
    .where((row) => row.channelId.in(channelIds))
    .all();

  const subscriberCounts = new Map<string, number>();
  const postCounts = new Map<string, number>();
  const mine = new Set<string>();

  for (const row of subscribers) {
    subscriberCounts.set(
      row.channelId,
      (subscriberCounts.get(row.channelId) ?? 0) + 1,
    );
    if (viewerId !== null && row.userId === viewerId) mine.add(row.channelId);
  }

  for (const row of posts) {
    postCounts.set(row.channelId, (postCounts.get(row.channelId) ?? 0) + 1);
  }

  return rows
    .map((row) => {
      // A channel whose author was deleted drops out rather than failing the
      // whole list, the way `services/library.ts` drops a vanished book.
      const author = authors.get(row.authorId);
      if (!author) return null;

      return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        description: row.description,
        subscriberCount: subscriberCounts.get(row.id) ?? 0,
        postCount: postCounts.get(row.id) ?? 0,
        createdAt: isoOf(row.createdAt),
        updatedAt: isoOf(row.updatedAt),
        author: {
          id: author.id,
          username: author.username,
          displayName: author.displayName,
          avatarUrl: author.avatarUrl,
        },
        subscribed: mine.has(row.id),
      };
    })
    .filter((channel): channel is Channel => channel !== null);
}

/* Reads ------------------------------------------------------------------ */

export async function listChannels(
  query: ChannelQuery,
  viewerId: string | null,
): Promise<Page<Channel>> {
  let collection = channelsBase();

  if (query.search) {
    const term = `%${query.search}%`;
    collection = collection.where((channel) =>
      or(channel.name.ilike(term), channel.description.ilike(term)),
    );
  }

  // Both flags need a caller to mean anything, so an anonymous request simply
  // ignores them rather than being answered with an empty page.
  if (query.mine && viewerId !== null) {
    collection = collection.where((channel) => channel.authorId.eq(viewerId));
  }

  if (query.subscribed && viewerId !== null) {
    const subscriptions = await db.orm.channels.ChannelSubscriber.select(
      "channelId",
    )
      .where((row) => row.userId.eq(viewerId))
      .all();

    const ids = subscriptions.map((row) => row.channelId);
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

    collection = collection.where((channel) => channel.id.in(ids));
  }

  const totals = await collection.aggregate((aggregate) => ({
    total: aggregate.count(),
  }));

  /**
   * `subscribers` sorts in JS for the reason `services/clubs.ts` spells out:
   * the count lives in a child table and the grouped collection cannot order
   * by an aggregate, so that one sort hydrates the filtered set and pages the
   * result. The other two page in SQL.
   */
  const paginate = query.sort !== "subscribers";

  let sorted = collection;
  if (query.sort === "newest") {
    sorted = collection.orderBy([
      (channel) => channel.createdAt.desc(),
      (channel) => channel.id.desc(),
    ]);
  } else if (query.sort === "name") {
    sorted = collection.orderBy([
      (channel) => channel.name.asc(),
      (channel) => channel.id.asc(),
    ]);
  } else {
    sorted = collection.orderBy((channel) => channel.id.asc());
  }

  const rows = paginate
    ? await sorted
        .offset((query.page - 1) * query.limit)
        .limit(query.limit)
        .all()
    : await sorted.all();

  let items = await hydrate(rows as ChannelRow[], viewerId);

  if (!paginate) {
    items = items
      .sort(
        (a, b) =>
          b.subscriberCount - a.subscriberCount || a.id.localeCompare(b.id),
      )
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
 * One channel by slug or by id, for the reason `services/stories.ts` gives:
 * the app addresses channels by slug, while everything the API returns carries
 * ids. The id branch is only attempted for something shaped like a UUID.
 */
async function findChannelRow(
  slugOrId: string,
  client: Orm = db,
): Promise<ChannelRow | null> {
  const bySlug = await channelsBase(client)
    .where((channel) => channel.slug.eq(slugOrId))
    .first();
  if (bySlug) return bySlug as ChannelRow;

  if (!UUID.test(slugOrId)) return null;

  const byId = await channelsBase(client)
    .where((channel) => channel.id.eq(slugOrId))
    .first();
  return (byId as ChannelRow | undefined) ?? null;
}

export async function getChannel(
  slugOrId: string,
  viewerId: string | null,
): Promise<Channel> {
  const row = await findChannelRow(slugOrId);
  if (!row) throw HttpError.notFound(CHANNEL_NOT_FOUND);

  const [channel] = await hydrate([row], viewerId);
  if (!channel) throw HttpError.notFound(CHANNEL_NOT_FOUND);

  return channel;
}

/* Authorisation ---------------------------------------------------------- */

/**
 * The channel `slugOrId` names, once the caller is established as its author.
 *
 * 404 for a channel that does not exist, 403 for one that does and is not the
 * caller's -- the distinction `services/authoring.ts` draws, for the same
 * reason: a channel's existence is public, its administration is not.
 */
async function ownedChannel(
  client: Orm,
  slugOrId: string,
  userId: string,
): Promise<ChannelRow> {
  const row = await findChannelRow(slugOrId, client);
  if (!row) throw HttpError.notFound(CHANNEL_NOT_FOUND);

  if (row.authorId !== userId) {
    throw HttpError.forbidden("That channel is not yours to manage.");
  }

  return row;
}

/* Writes ----------------------------------------------------------------- */

export interface ChannelInput {
  name: string;
  description?: string | null | undefined;
}

export async function createChannel(
  userId: string,
  input: ChannelInput,
): Promise<Channel> {
  const timestamp = now();

  const channelId = await db.transaction(async (tx) => {
    const slug = await uniqueSlug(input.name, async (candidate) => {
      const taken = await tx.orm.channels.BroadcastChannel.select("id")
        .where((channel) => channel.slug.eq(candidate))
        .first();
      return taken !== undefined && taken !== null;
    });

    const channel = await tx.orm.channels.BroadcastChannel.select("id").create({
      authorId: userId,
      name: input.name,
      slug,
      description: input.description ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    /**
     * Opening a channel is an authoring act, and the flag exists to tell the
     * UI which navigation to show -- the same reason `createStory` sets it.
     */
    await tx.orm.auth.User.where((user) => user.id.eq(userId)).update({
      isAuthor: true,
      updatedAt: timestamp,
    });

    return channel.id;
  });

  return getChannel(channelId, userId);
}

export async function updateChannel(
  userId: string,
  slugOrId: string,
  input: Partial<ChannelInput>,
): Promise<Channel> {
  const timestamp = now();

  const channelId = await db.transaction(async (tx) => {
    const channel = await ownedChannel(tx, slugOrId, userId);

    const changes: Record<string, unknown> = { updatedAt: timestamp };

    if (input.name !== undefined && input.name !== channel.name) {
      changes["name"] = input.name;
    }
    if (input.description !== undefined) {
      changes["description"] = input.description ?? null;
    }

    // The slug is not re-derived on a rename: subscribers link to a channel
    // and those links have to keep working. `clubs.BookClub` and
    // `content.Story` make the same trade.
    await tx.orm.channels.BroadcastChannel.where((row) =>
      row.id.eq(channel.id),
    ).update(changes);

    return channel.id;
  });

  return getChannel(channelId, userId);
}

export async function deleteChannel(
  userId: string,
  slugOrId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const channel = await ownedChannel(tx, slugOrId, userId);

    // Posts and subscribers both reference the channel, so they go first.
    await tx.orm.channels.ChannelPost.where((row) =>
      row.channelId.eq(channel.id),
    ).delete();
    await tx.orm.channels.ChannelSubscriber.where((row) =>
      row.channelId.eq(channel.id),
    ).delete();
    await tx.orm.channels.BroadcastChannel.where((row) =>
      row.id.eq(channel.id),
    ).delete();
  });
}

/* Subscriptions ---------------------------------------------------------- */

/**
 * Subscribes the caller, or reports the subscription they already have.
 *
 * Idempotent in both directions by contract: subscribing twice succeeds, and
 * so does unsubscribing from something you never followed. The button these
 * serve can be double-clicked, and an error would misdescribe the outcome --
 * the caller is subscribed either way.
 */
export async function subscribe(
  userId: string,
  slugOrId: string,
): Promise<{ subscribed: true; subscribedAt: string }> {
  const channel = await findChannelRow(slugOrId);
  if (!channel) throw HttpError.notFound(CHANNEL_NOT_FOUND);

  const existing = await db.orm.channels.ChannelSubscriber.select(
    "id",
    "subscribedAt",
  )
    .where((row) => row.channelId.eq(channel.id))
    .where((row) => row.userId.eq(userId))
    .first();

  if (existing) {
    return { subscribed: true, subscribedAt: isoOf(existing.subscribedAt) };
  }

  const timestamp = now();

  try {
    const created = await db.orm.channels.ChannelSubscriber.select(
      "subscribedAt",
    ).create({
      channelId: channel.id,
      userId,
      subscribedAt: timestamp,
    });

    return { subscribed: true, subscribedAt: isoOf(created.subscribedAt) };
  } catch (error) {
    // Two simultaneous subscribes: the unique index is the real arbiter, and
    // the loser is still subscribed, so answer as the pre-check would have.
    if (!isUniqueViolation(error)) throw error;

    return { subscribed: true, subscribedAt: isoOf(timestamp) };
  }
}

export async function unsubscribe(
  userId: string,
  slugOrId: string,
): Promise<void> {
  const channel = await findChannelRow(slugOrId);
  if (!channel) throw HttpError.notFound(CHANNEL_NOT_FOUND);

  await db.orm.channels.ChannelSubscriber.where((row) =>
    row.channelId.eq(channel.id),
  )
    .where((row) => row.userId.eq(userId))
    .delete();
}

/* Posts ------------------------------------------------------------------ */

function toPost(row: {
  id: string;
  channelId: string;
  title: string;
  content: string;
  postedAt: unknown;
  updatedAt: unknown;
}): ChannelPost {
  return {
    id: row.id,
    channelId: row.channelId,
    title: row.title,
    content: row.content,
    postedAt: isoOf(row.postedAt),
    updatedAt: isoOf(row.updatedAt),
  };
}

function postsBase() {
  return db.orm.channels.ChannelPost.select(
    "id",
    "channelId",
    "title",
    "content",
    "postedAt",
    "updatedAt",
  );
}

/** A channel's feed: newest first, public. */
export async function listPosts(
  slugOrId: string,
  page: number,
  limit: number,
): Promise<Page<ChannelPost>> {
  const channel = await findChannelRow(slugOrId);
  if (!channel) throw HttpError.notFound(CHANNEL_NOT_FOUND);

  const collection = postsBase().where((row) =>
    row.channelId.eq(channel.id),
  );

  const totals = await collection.aggregate((aggregate) => ({
    total: aggregate.count(),
  }));

  /**
   * `id` is the tie-breaker so pagination is stable: two posts written in the
   * same millisecond can otherwise swap places between page 1 and 2 and a
   * reader sees one of them twice.
   */
  const rows = await collection
    .orderBy([(row) => row.postedAt.desc(), (row) => row.id.desc()])
    .offset((page - 1) * limit)
    .limit(limit)
    .all();

  const total = totals.total;

  return {
    items: rows.map(toPost),
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
    hasMore: page * limit < total,
  };
}

export interface PostInput {
  title: string;
  content: string;
}

export async function createPost(
  userId: string,
  slugOrId: string,
  input: PostInput,
): Promise<ChannelPost> {
  const timestamp = now();

  const postId = await db.transaction(async (tx) => {
    const channel = await ownedChannel(tx, slugOrId, userId);

    const created = await tx.orm.channels.ChannelPost.select("id").create({
      channelId: channel.id,
      title: input.title,
      content: input.content,
      postedAt: timestamp,
      updatedAt: timestamp,
    });

    return created.id;
  });

  const row = await postsBase().where((post) => post.id.eq(postId)).first();
  if (!row) throw HttpError.notFound(POST_NOT_FOUND);

  return toPost(row);
}

/**
 * The post `postId` names, once the caller is established as the author of the
 * channel it belongs to. Entered from a post id rather than a channel, the way
 * `services/authoring.ts` enters ownership from a chapter.
 */
async function ownedPost(
  client: Orm,
  postId: string,
  userId: string,
): Promise<{ id: string; channelId: string }> {
  const post = await client.orm.channels.ChannelPost.select("id", "channelId")
    .where((row) => row.id.eq(postId))
    .first();

  if (!post) throw HttpError.notFound(POST_NOT_FOUND);

  await ownedChannel(client, post.channelId, userId);

  return post;
}

export async function updatePost(
  userId: string,
  postId: string,
  input: Partial<PostInput>,
): Promise<ChannelPost> {
  const timestamp = now();

  await db.transaction(async (tx) => {
    const post = await ownedPost(tx, postId, userId);

    const changes: Record<string, unknown> = { updatedAt: timestamp };
    if (input.title !== undefined) changes["title"] = input.title;
    if (input.content !== undefined) changes["content"] = input.content;

    await tx.orm.channels.ChannelPost.where((row) => row.id.eq(post.id)).update(
      changes,
    );
  });

  const row = await postsBase().where((post) => post.id.eq(postId)).first();
  if (!row) throw HttpError.notFound(POST_NOT_FOUND);

  return toPost(row);
}

export async function deletePost(
  userId: string,
  postId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const post = await ownedPost(tx, postId, userId);

    await tx.orm.channels.ChannelPost.where((row) =>
      row.id.eq(post.id),
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
