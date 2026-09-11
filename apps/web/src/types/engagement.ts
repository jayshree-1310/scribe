/**
 * Comment and rating types.
 *
 * These mirror the API responses in `apps/api/src/services/engagement.ts`
 * exactly, the same way `types/clubs.ts` mirrors the clubs service. Separate
 * from `domain.ts`, which describes the mock layer the rest of the app still
 * runs on -- and which carries no comment or rating shape at all, the mock
 * functions for both having been removed before this was built.
 *
 * A comment is deliberately the same shape as a club's `Discussion`: one
 * thread model across every surface that takes user-written text.
 */

export interface CommentUser {
  id: string
  username: string
  /** Absent for password signups; fall back to the username for display. */
  displayName: string | null
  avatarUrl: string | null
}

export interface Comment {
  id: string
  storyId: string
  /** The chapter this was written against, or null for a story-wide comment. */
  chapterId: string | null
  /** Null for a top-level thread; the thread's id for a reply. */
  parentId: string | null
  content: string
  createdAt: string
  updatedAt: string
  /** Always 0 for a reply: replies are one level deep. */
  replyCount: number
  user: CommentUser
}

export interface CommentPage {
  items: Comment[]
  page: number
  limit: number
  total: number
  totalPages: number
  hasMore: boolean
}

/** Score -> how many readers gave it. Every key 1-5 is present, even at zero. */
export type RatingBreakdown = Record<number, number>

export interface RatingSummary {
  /** Null when nothing has been rated, rather than a misleading 0. */
  average: number | null
  count: number
  breakdown: RatingBreakdown
  /** The caller's own score, or null when signed out or not yet rated. */
  mine: number | null
}

/** The longest body `POST /api/stories/:id/comments` accepts. */
export const COMMENT_MAX_LENGTH = 2000

/**
 * Display name for a commenter.
 *
 * `displayName` is null for accounts created with a password, which have never
 * been asked for one, so the handle stands in -- the same fallback
 * `types/clubs.ts` applies to club members.
 */
export function commentUserName(user: CommentUser): string {
  if (user.displayName && user.displayName.trim().length > 0) {
    return user.displayName
  }

  return user.username
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}
