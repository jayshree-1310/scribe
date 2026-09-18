/**
 * Recommendation data access.
 *
 * Talks to the real Scribe API through the shared fetch wrapper, so errors
 * arrive as `ApiError` with a message safe to show. Shares `stories-api.ts`'s
 * dev-identity header for the reason that module gives — and here it decides
 * whose taste the ranking is built from, so a dev without a session sees the
 * dev user's recommendations.
 */

import { request } from '../lib/api-client'
import { readerHeaders } from './stories-api'
import type { AuthorSuggestion, Recommendations } from '../types/recommendations'

export async function getRecommendations(
  limit = 12,
): Promise<Recommendations> {
  return request<Recommendations>('/recommendations', {
    headers: readerHeaders(),
    query: { limit: String(limit) },
  })
}

/**
 * Writers to suggest, ranked by the genres the reader has already saved — so
 * the onboarding flow has to save its genre step before it asks for these.
 */
export async function getSuggestedAuthors(
  limit = 12,
): Promise<AuthorSuggestion[]> {
  const { authors } = await request<{ authors: AuthorSuggestion[] }>(
    '/recommendations/authors',
    { headers: readerHeaders(), query: { limit: String(limit) } },
  )
  return authors
}
