/**
 * Writing challenge types.
 *
 * These mirror the API responses in `apps/api/src/services/challenges.ts`
 * exactly, the same way `types/clubs.ts` mirrors the clubs service. Separate
 * from `domain.ts`, which describes the mock layer -- and which no longer
 * carries a challenge shape at all.
 *
 * What the mock invented and nothing stores, so it is absent here:
 *
 * - `hue` — purely presentational, so the UI derives one from the slug
 *   through `hueFor`, the same way a club's and a channel's banner does.
 * - an entry's `voteCount` and `rank` as stored fields — there is no ballot in
 *   the contract. The board ranks by the star ratings each entry's story has
 *   earned, and `rank` is computed by the query that orders them; see
 *   `RANKING` in the service for the rule and why summing beats averaging.
 * - `hostId` as a bare id — the API returns the host as a user summary, so
 *   nothing has to look one up to render a name.
 *
 * `state` is `'past'`, not the mock's `'completed'`: it says where the clock
 * is, not whether anybody finished.
 */

import type { Story } from './stories'

export interface ChallengeUser {
  id: string
  username: string
  /** Absent for password signups; fall back to the username for display. */
  displayName: string | null
  avatarUrl: string | null
}

export const CHALLENGE_STATES = ['upcoming', 'active', 'past'] as const

export type ChallengeState = (typeof CHALLENGE_STATES)[number]

export interface Challenge {
  id: string
  slug: string
  title: string
  /** The brief, rendered as the challenge's pull quote. */
  prompt: string
  description: string | null
  wordTarget: number | null
  /** Derived from the window against the clock; there is no status column. */
  state: ChallengeState
  startsAt: string
  endsAt: string
  /** Writers who have taken a place, whether or not they have submitted. */
  participantCount: number
  /**
   * Places with a story attached — which is not the same as the number of rows
   * on the leaderboard, because an entry whose story is still a draft counts
   * here and is not on the public board until it is published.
   */
  entryCount: number
  createdAt: string
  updatedAt: string
  /** Null only if the hosting account has since been deleted. */
  host: ChallengeUser | null
}

/** The caller's own place in a challenge. Nobody else's is ever returned. */
export interface ChallengeEntry {
  id: string
  challengeId: string
  /** Null until a story is attached. */
  story: Story | null
  /** The entrant's own note to the host. */
  note: string | null
  submittedAt: string
  updatedAt: string
}

export interface ChallengeDetail extends Challenge {
  /** Null when signed out, or when the caller has not entered. */
  entry: ChallengeEntry | null
}

export interface LeaderboardRow {
  rank: number
  entryId: string
  submittedAt: string
  /** The stars the story has been given, summed — what the rank is built on. */
  score: number
  ratingCount: number
  ratingAverage: number | null
  user: ChallengeUser
  story: Story
}

/** Challenges split by the only thing that separates them: the clock. */
export interface ChallengeBoard {
  active: Challenge[]
  upcoming: Challenge[]
  past: Challenge[]
}

export interface LeaderboardPage {
  items: LeaderboardRow[]
  page: number
  limit: number
  total: number
  totalPages: number
  hasMore: boolean
}

/**
 * Display name for an entrant.
 *
 * `displayName` is null for accounts created with a password, which have never
 * been asked for one, so the handle stands in — the same fallback
 * `types/clubs.ts` applies to members.
 */
export function challengeUserName(user: ChallengeUser): string {
  if (user.displayName && user.displayName.trim().length > 0) {
    return user.displayName
  }

  return user.username
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/** True while the window is open — the only time an entry can change. */
export function isOpen(challenge: Challenge): boolean {
  return challenge.state === 'active'
}
