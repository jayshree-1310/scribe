/**
 * What is left of the mock data layer.
 *
 * Stories, chapters, books, shelves, comments, ratings, reading history,
 * clubs, channels, challenges and badges all come from the API now -- see
 * `data/stories-api.ts`, `data/books-api.ts`, `data/account-api.ts`,
 * `data/clubs-api.ts`, `data/channels-api.ts`, `data/challenges-api.ts` and
 * `data/gamification-api.ts`. What remains here is the one feature with no
 * endpoint yet: the author directory `OnboardingPage` picks from, which wants
 * somewhere to persist its answers (Task 16) rather than another read.
 */

import * as db from './mock-db'
import type { User } from '../types/domain'

/** Simulated round-trip, kept short enough not to slow development down. */
const LATENCY_MS = 260

function delay<T>(value: T, ms = LATENCY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

/* Reference data ------------------------------------------------------- */

export function getAuthors(): Promise<User[]> {
  return delay(db.authors, 140)
}

/**
 * The remaining fixtures, for the one consumer that needs them directly:
 * `AuthProvider` fills the presentational half of a session (avatar hue,
 * follower counts, reading stats) that the API does not carry yet.
 */
export { db }
