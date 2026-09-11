/**
 * What is left of the mock data layer.
 *
 * Stories, chapters, books, shelves, comments, ratings, reading history,
 * clubs and channels all come from the API now -- see `data/stories-api.ts`,
 * `data/books-api.ts`, `data/account-api.ts`, `data/clubs-api.ts` and
 * `data/channels-api.ts`. What remains here are the features with no
 * endpoints yet: challenges, badges and the author directory. Each one goes
 * the same way as its API lands.
 */

import * as db from './mock-db'
import type {
  Badge,
  ChallengeEntry,
  User,
  UserBadge,
  WritingChallenge,
} from '../types/domain'

/** Simulated round-trip, kept short enough not to slow development down. */
const LATENCY_MS = 260

function delay<T>(value: T, ms = LATENCY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} could not be found.`)
    this.name = 'NotFoundError'
  }
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

/* Challenges ----------------------------------------------------------- */

export function getChallenges(): Promise<WritingChallenge[]> {
  return delay(db.challenges, 200)
}

export function getChallenge(slug: string): Promise<WritingChallenge> {
  const challenge = db.challenges.find((item) => item.slug === slug || item.id === slug)
  if (!challenge) return Promise.reject(new NotFoundError('That challenge'))
  return delay(challenge, 200)
}

export interface LeaderboardRow extends ChallengeEntry {
  user: User
}

export function getChallengeLeaderboard(challengeId: string): Promise<LeaderboardRow[]> {
  const results = db.challengeEntries
    .filter((entry) => entry.challengeId === challengeId)
    .map((entry) => ({
      ...entry,
      user: db.userById.get(entry.userId) ?? db.currentUser,
    }))
    .sort((a, b) => a.rank - b.rank)

  return delay(results, 220)
}

/**
 * The remaining fixtures, for the one consumer that needs them directly:
 * `AuthProvider` fills the presentational half of a session (avatar hue,
 * follower counts, reading stats) that the API does not carry yet.
 */
export { db }
