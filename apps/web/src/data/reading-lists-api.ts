/**
 * Reading list data access, through the shared fetch wrapper.
 */

import { request } from '../lib/api-client'
import type {
  FollowListState,
  ListEntry,
  ListSort,
  ReadingListDetail,
  ReadingListPage,
} from '../types/reading-lists'

/* Reads ------------------------------------------------------------------ */

export interface ListFilters {
  /** One reader's lists by username: all of them for the owner, else the public ones. */
  owner?: string
  /** The lists the caller follows. */
  followed?: boolean
  /** Adds `hasStory` for this story to each list. */
  storyId?: string
  sort?: ListSort
  page?: number
  limit?: number
}

export async function listReadingLists(
  filters: ListFilters = {},
): Promise<ReadingListPage> {
  return request<ReadingListPage>('/lists', {
    query: {
      owner: filters.owner,
      followed: filters.followed ? 'true' : undefined,
      storyId: filters.storyId,
      sort: filters.sort,
      page: filters.page === undefined ? undefined : String(filters.page),
      limit: filters.limit === undefined ? undefined : String(filters.limit),
    },
  })
}

/** One list by slug or id, with its entries. */
export async function getReadingList(slugOrId: string): Promise<ReadingListDetail> {
  const { list } = await request<{ list: ReadingListDetail }>(
    `/lists/${encodeURIComponent(slugOrId)}`,
  )
  return list
}

/* Lists ------------------------------------------------------------------ */

export interface ListInput {
  name: string
  description?: string | null
  isPublic?: boolean
}

export async function createReadingList(input: ListInput): Promise<ReadingListDetail> {
  const { list } = await request<{ list: ReadingListDetail }>('/lists', {
    method: 'POST',
    body: input,
  })
  return list
}

export async function updateReadingList(
  listId: string,
  input: Partial<ListInput>,
): Promise<ReadingListDetail> {
  const { list } = await request<{ list: ReadingListDetail }>(
    `/lists/${encodeURIComponent(listId)}`,
    { method: 'PATCH', body: input },
  )
  return list
}

export async function deleteReadingList(listId: string): Promise<void> {
  await request<void>(`/lists/${encodeURIComponent(listId)}`, { method: 'DELETE' })
}

/* Entries ---------------------------------------------------------------- */

export async function addToList(
  listId: string,
  storyId: string,
  note?: string | null,
): Promise<ListEntry> {
  const { entry } = await request<{ entry: ListEntry }>(
    `/lists/${encodeURIComponent(listId)}/entries`,
    { method: 'POST', body: { storyId, note: note ?? null } },
  )
  return entry
}

export async function updateListNote(
  listId: string,
  storyId: string,
  note: string | null,
): Promise<ListEntry> {
  const { entry } = await request<{ entry: ListEntry }>(
    `/lists/${encodeURIComponent(listId)}/entries/${encodeURIComponent(storyId)}`,
    { method: 'PATCH', body: { note } },
  )
  return entry
}

export async function removeFromList(listId: string, storyId: string): Promise<void> {
  await request<void>(
    `/lists/${encodeURIComponent(listId)}/entries/${encodeURIComponent(storyId)}`,
    { method: 'DELETE' },
  )
}

/* Following -------------------------------------------------------------- */

export async function followList(listId: string): Promise<FollowListState> {
  return request<FollowListState>(`/lists/${encodeURIComponent(listId)}/follow`, {
    method: 'POST',
  })
}

export async function unfollowList(listId: string): Promise<FollowListState> {
  return request<FollowListState>(`/lists/${encodeURIComponent(listId)}/follow`, {
    method: 'DELETE',
  })
}
