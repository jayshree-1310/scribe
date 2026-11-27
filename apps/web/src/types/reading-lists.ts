/**
 * Reading list types.
 *
 * These mirror the API responses in `apps/api/src/services/reading-lists.ts`
 * exactly, the same way `types/channels.ts` mirrors the channels service.
 */

import type { Story } from './stories'

/** The limits the API enforces, so the forms can say them first. */
export const LIST_NAME_MAX = 80
export const LIST_DESCRIPTION_MAX = 1000
export const LIST_NOTE_MAX = 500
export const MAX_LISTS_PER_USER = 50
export const MAX_ENTRIES_PER_LIST = 100

export interface ListOwner {
  id: string
  username: string
  /** Absent for password signups; fall back to the username for display. */
  displayName: string | null
  avatarUrl: string | null
}

export interface ReadingList {
  id: string
  slug: string
  name: string
  description: string | null
  /** False keeps the list to its owner. */
  isPublic: boolean
  createdAt: string
  /** Moves when the list is edited or a story is added or removed. */
  updatedAt: string
  owner: ListOwner
  /** Stories a reader can open, not entries that exist. */
  storyCount: number
  followerCount: number
  /** The caller follows it; always false when signed out. */
  following: boolean
  isOwner: boolean
  /** The newest few stories on it, for the card's covers. */
  previews: Story[]
  /** Present only when the request asked about one story (`storyId`). */
  hasStory?: boolean
}

export interface ListEntry {
  id: string
  note: string | null
  addedAt: string
  updatedAt: string
  story: Story
}

export interface ReadingListDetail extends ReadingList {
  /** Newest first. */
  entries: ListEntry[]
}

export interface ReadingListPage {
  items: ReadingList[]
  page: number
  limit: number
  total: number
  totalPages: number
  hasMore: boolean
}

export type ListSort = 'popular' | 'recent'

export interface FollowListState {
  following: boolean
  followerCount: number
}

/** Where a story on a list opens: a catalogue book has its own page. */
export function storyHref(story: Pick<Story, 'id' | 'slug' | 'source'>): string {
  return story.source === 'CATALOGUE' ? `/book/${story.id}` : `/story/${story.slug}`
}

/** The owner's name as the UI shows it, the fallback `types/channels.ts` uses. */
export function ownerName(owner: ListOwner): string {
  if (owner.displayName && owner.displayName.trim().length > 0) return owner.displayName

  return owner.username
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}
