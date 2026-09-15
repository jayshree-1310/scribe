/**
 * What is left of the mock data layer.
 *
 * Stories, chapters, books, shelves, comments, ratings, reading history,
 * clubs, channels and challenges all come from the API now -- see
 * `data/stories-api.ts`, `data/books-api.ts`, `data/account-api.ts`,
 * `data/clubs-api.ts`, `data/channels-api.ts` and `data/challenges-api.ts`.
 * What remains here are the features with no endpoints yet: badges and the
 * author directory. Each one goes the same way as its API lands.
 */

import * as db from './mock-db'
import type { Badge, User, UserBadge } from '../types/domain'

/** Simulated round-trip, kept short enough not to slow development down. */
const LATENCY_MS = 260

function delay<T>(value: T, ms = LATENCY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

/* Reference data ------------------------------------------------------- */

export function getAuthors(): Promise<User[]> {
  return delay(db.authors, 140)
}

/* Gamification --------------------------------------------------------- */

export interface BadgeWithProgress {
  badge: Badge
  earned: boolean
  earnedAt: string | null
  progress: number
}

export function getBadges(): Promise<BadgeWithProgress[]> {
  const byId = new Map<string, UserBadge>(
    db.userBadges.map((entry) => [entry.badgeId, entry]),
  )

  const results = db.badges.map((badge) => {
    const owned = byId.get(badge.id)
    return {
      badge,
      earned: Boolean(owned?.earnedAt),
      earnedAt: owned?.earnedAt ?? null,
      progress: owned?.progress ?? 0,
    }
  })

  return delay(results, 200)
}

/**
 * The remaining fixtures, for the one consumer that needs them directly:
 * `AuthProvider` fills the presentational half of a session (avatar hue,
 * follower counts, reading stats) that the API does not carry yet.
 */
export { db }
