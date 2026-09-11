/**
 * Broadcast channel data access.
 *
 * Every function here talks to the real Scribe API through the shared fetch
 * wrapper, so errors arrive as `ApiError` with a message safe to show. Shares
 * `stories-api.ts`'s dev-identity header for the reason that module gives.
 */

import { request } from '../lib/api-client'
import { readerHeaders } from './stories-api'
import type {
  Channel,
  ChannelPage,
  ChannelPost,
  ChannelPostPage,
  ChannelSort,
} from '../types/channels'

/* Reads ------------------------------------------------------------------ */

export interface ChannelFilters {
  search?: string
  /** Only channels the caller owns. Ignored when signed out. */
  mine?: boolean
  /** Only channels the caller subscribes to. Ignored when signed out. */
  subscribed?: boolean
  sort?: ChannelSort
  page?: number
  limit?: number
}

export async function listChannels(
  filters: ChannelFilters = {},
): Promise<ChannelPage> {
  return request<ChannelPage>('/channels', {
    headers: readerHeaders(),
    query: {
      search: filters.search?.trim() || undefined,
      // Omitted rather than sent as "false": the API reads an absent flag as
      // "no filter", and `false` would mean the same while saying less.
      mine: filters.mine ? 'true' : undefined,
      subscribed: filters.subscribed ? 'true' : undefined,
      sort: filters.sort,
      page: filters.page === undefined ? undefined : String(filters.page),
      limit: filters.limit === undefined ? undefined : String(filters.limit),
    },
  })
}

/** One channel by slug or by id. */
export async function getChannel(slugOrId: string): Promise<Channel> {
  const { channel } = await request<{ channel: Channel }>(
    `/channels/${encodeURIComponent(slugOrId)}`,
    { headers: readerHeaders() },
  )
  return channel
}

/** A channel's feed, newest first. Public. */
export async function getChannelPosts(
  slugOrId: string,
  options: { page?: number; limit?: number } = {},
): Promise<ChannelPostPage> {
  return request<ChannelPostPage>(
    `/channels/${encodeURIComponent(slugOrId)}/posts`,
    {
      headers: readerHeaders(),
      query: {
        page: options.page === undefined ? undefined : String(options.page),
        limit: options.limit === undefined ? undefined : String(options.limit),
      },
    },
  )
}

/* Writes ----------------------------------------------------------------- */

export interface ChannelInput {
  name: string
  description?: string | null
}

export async function createChannel(
  input: ChannelInput,
): Promise<Channel> {
  const { channel } = await request<{ channel: Channel }>('/channels', {
    method: 'POST',
    headers: readerHeaders(),
    body: input,
  })
  return channel
}

export async function updateChannel(
  channelId: string,
  input: Partial<ChannelInput>,
): Promise<Channel> {
  const { channel } = await request<{ channel: Channel }>(
    `/channels/${encodeURIComponent(channelId)}`,
    { method: 'PATCH', headers: readerHeaders(), body: input },
  )
  return channel
}

export async function deleteChannel(channelId: string): Promise<void> {
  await request<void>(`/channels/${encodeURIComponent(channelId)}`, {
    method: 'DELETE',
    headers: readerHeaders(),
  })
}

/** Idempotent both ways: subscribing twice, or unsubscribing twice, succeeds. */
export async function subscribe(channelId: string): Promise<void> {
  await request<void>(`/channels/${encodeURIComponent(channelId)}/subscribe`, {
    method: 'POST',
    headers: readerHeaders(),
  })
}

export async function unsubscribe(channelId: string): Promise<void> {
  await request<void>(`/channels/${encodeURIComponent(channelId)}/subscribe`, {
    method: 'DELETE',
    headers: readerHeaders(),
  })
}

export interface PostInput {
  title: string
  content: string
}

/** Channel owner only. */
export async function createPost(
  channelId: string,
  input: PostInput,
): Promise<ChannelPost> {
  const { post } = await request<{ post: ChannelPost }>(
    `/channels/${encodeURIComponent(channelId)}/posts`,
    { method: 'POST', headers: readerHeaders(), body: input },
  )
  return post
}

export async function updatePost(
  postId: string,
  input: Partial<PostInput>,
): Promise<ChannelPost> {
  const { post } = await request<{ post: ChannelPost }>(
    `/channels/posts/${encodeURIComponent(postId)}`,
    { method: 'PATCH', headers: readerHeaders(), body: input },
  )
  return post
}

export async function deletePost(postId: string): Promise<void> {
  await request<void>(`/channels/posts/${encodeURIComponent(postId)}`, {
    method: 'DELETE',
    headers: readerHeaders(),
  })
}
