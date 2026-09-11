/**
 * Public profile and follow-graph types.
 *
 * These mirror the API responses in `apps/api/src/services/users.ts` exactly,
 * the same way `types/clubs.ts` mirrors the clubs service. Separate from
 * `domain.ts`, whose `User` is the mock's shape and carries several fields
 * nothing stores — `avatarHue` (derived from the username by `hueFor`) and a
 * `stats` block of reading aggregates that has no endpoint behind it.
 *
 * What a public profile deliberately does *not* carry: `email`,
 * `emailVerified` and `hasPassword`. Those belong to the signed-in reader's
 * own account (`data/account-api.ts`) and are nobody else's to know.
 */

export interface ProfileUser {
  id: string
  username: string
  /** Absent for password signups; fall back to the username for display. */
  displayName: string | null
  avatarUrl: string | null
}

export interface PublicProfile extends ProfileUser {
  bio: string | null
  isAuthor: boolean
  readerLevel: number
  authorLevel: number
  readingStreak: number
  joinedAt: string
  /**
   * Stories the caller may see by this author — the published ones, plus the
   * author's own drafts when they are looking at their own profile. The same
   * rule the Stories tab pages through, so the two cannot disagree.
   */
  storyCount: number
  followerCount: number
  followingCount: number
  /** Whether the caller follows this person. False when signed out. */
  isFollowing: boolean
  /** Whether this profile is the caller's own. */
  isMe: boolean
}

export interface FollowEntry {
  user: ProfileUser
  followedAt: string
  /** Whether the *caller* follows this person — what "Follow back" needs. */
  isFollowing: boolean
}

export interface FollowPage {
  items: FollowEntry[]
  page: number
  limit: number
  total: number
  totalPages: number
  hasMore: boolean
}

/** What a follow write returns, so the button redraws without a refetch. */
export interface FollowState {
  following: boolean
  followerCount: number
}
