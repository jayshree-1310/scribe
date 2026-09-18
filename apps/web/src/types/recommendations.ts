/**
 * Recommendation types.
 *
 * These mirror `apps/api/src/services/recommendations.ts` exactly. A
 * recommendation carries a whole `Story`, not an id, so a rail renders with
 * the same card every other story surface uses.
 */

import type { Story } from './stories'

/**
 * Which path produced the list. `trending` means the reader had no signal yet
 * — no genres, no shelves, no reading, no ratings, no follows — so the shelf
 * should be worded as "what everyone is reading" rather than "for you".
 */
export type RecommendationBasis = 'personal' | 'trending'

export interface Recommendation {
  story: Story
  /** The summed score. Zero on the trending path, which is not ranked. */
  score: number
  /** The strongest reason, already worded for a reader. Never empty. */
  reason: string
}

export interface Recommendations {
  items: Recommendation[]
  basis: RecommendationBasis
}

/** Somebody worth following, for the onboarding step that asks. */
export interface AuthorSuggestion {
  id: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  followerCount: number
  storyCount: number
}
