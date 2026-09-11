/**
 * Book club types.
 *
 * These mirror the API responses in `apps/api/src/services/clubs.ts` exactly,
 * the same way `types/stories.ts` mirrors the stories service. Separate from
 * `domain.ts`, which describes the mock layer the rest of the app still runs
 * on -- and which no longer carries a club shape at all.
 *
 * Three fields the mock invented are deliberately absent, because nothing
 * stores them: `isPrivate` (there is no invite or approval flow -- every club
 * is open), `genreIds` (clubs have no genre relation), and `hue` (purely
 * presentational, so the UI derives one from the slug through `hueFor`).
 */

import type { Story } from './stories'

export interface ClubUser {
  id: string
  username: string
  /** Absent for password signups; fall back to the username for display. */
  displayName: string | null
  avatarUrl: string | null
}

export const CLUB_ROLES = ['OWNER', 'ADMIN', 'MEMBER'] as const

export type ClubRole = (typeof CLUB_ROLES)[number]

export const CLUB_ROLE_LABELS: Record<ClubRole, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MEMBER: 'Member',
}

export interface ClubMember {
  user: ClubUser
  role: ClubRole
  joinedAt: string
}

/** The caller's own standing in a club; null when signed out or not a member. */
export interface ClubMembership {
  role: ClubRole
  joinedAt: string
}

export interface Club {
  id: string
  slug: string
  name: string
  description: string | null
  memberCount: number
  /** Top-level threads only, not threads plus replies. */
  discussionCount: number
  createdAt: string
  updatedAt: string
  owner: ClubUser | null
  /**
   * Null between reads — and also when the club's current read is a story the
   * caller cannot see, so this never leaks an unpublished title.
   */
  currentStory: Story | null
  membership: ClubMembership | null
}

export interface ClubDetail extends Club {
  /** `OWNER` and `ADMIN` members, for the club's moderator list. */
  moderators: ClubMember[]
}

export interface Discussion {
  id: string
  clubId: string
  /** Null for a top-level thread; the thread's id for a reply. */
  parentId: string | null
  body: string
  createdAt: string
  updatedAt: string
  /** Always 0 for a reply: replies are one level deep. */
  replyCount: number
  user: ClubUser
}

export interface ClubPage {
  items: Club[]
  page: number
  limit: number
  total: number
  totalPages: number
  hasMore: boolean
}

export interface DiscussionPage {
  items: Discussion[]
  page: number
  limit: number
  total: number
  totalPages: number
  hasMore: boolean
}

export interface MemberPage {
  items: ClubMember[]
  page: number
  limit: number
  total: number
  totalPages: number
  hasMore: boolean
}

export const CLUB_SORTS = ['members', 'newest', 'name'] as const

export type ClubSort = (typeof CLUB_SORTS)[number]

/**
 * Club display name for a member.
 *
 * `displayName` is null for accounts created with a password, which have never
 * been asked for one, so the handle stands in — the same fallback
 * `types/stories.ts` applies to authors.
 */
export function clubUserName(user: ClubUser): string {
  if (user.displayName && user.displayName.trim().length > 0) {
    return user.displayName
  }

  return user.username
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/** True when the caller may rename the club, moderate it, or set its read. */
export function canModerate(club: Club): boolean {
  return club.membership?.role === 'OWNER' || club.membership?.role === 'ADMIN'
}
