/**
 * Broadcast channel types.
 *
 * These mirror the API responses in `apps/api/src/services/channels.ts`
 * exactly, the same way `types/stories.ts` mirrors the stories service.
 * Separate from `domain.ts`, which described the mock layer and no longer
 * carries a channel shape.
 *
 * Four fields the mock invented are deliberately absent, because nothing
 * records them: a post's `likeCount` and `commentCount` (channel posts have no
 * like or comment model — a channel is one-way), its `linkedStoryId` (there is
 * no post-to-story relation), and the author's `avatarHue`, which the UI
 * derives from the username through `hueFor`.
 */

export interface ChannelAuthor {
  id: string
  username: string
  /** Absent for password signups; fall back to the username for display. */
  displayName: string | null
  avatarUrl: string | null
}

export interface Channel {
  id: string
  slug: string
  name: string
  description: string | null
  subscriberCount: number
  postCount: number
  createdAt: string
  updatedAt: string
  author: ChannelAuthor
  /** The caller's subscription state; always false when signed out. */
  subscribed: boolean
}

export interface ChannelPost {
  id: string
  channelId: string
  title: string
  /** Paragraphs separated by blank lines; see `paragraphsOf` in `stories.ts`. */
  content: string
  postedAt: string
  /** Differs from `postedAt` once the post has been edited. */
  updatedAt: string
}

export interface ChannelPage {
  items: Channel[]
  page: number
  limit: number
  total: number
  totalPages: number
  hasMore: boolean
}

export interface ChannelPostPage {
  items: ChannelPost[]
  page: number
  limit: number
  total: number
  totalPages: number
  hasMore: boolean
}

export const CHANNEL_SORTS = ['subscribers', 'newest', 'name'] as const

export type ChannelSort = (typeof CHANNEL_SORTS)[number]

/**
 * Author display name.
 *
 * `displayName` is null for accounts created with a password, so the handle is
 * title-cased as a stand-in — the same fallback `types/stories.ts` applies.
 */
export function channelAuthorName(author: ChannelAuthor): string {
  if (author.displayName && author.displayName.trim().length > 0) {
    return author.displayName
  }

  return author.username
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}
