/**
 * Author analytics data access.
 *
 * Two reads, both `/api/author/...` and both requiring a session — there is no
 * such thing as somebody else's analytics, so neither call takes an author id:
 * the API answers for whoever is asking. Shares `stories-api.ts`'s dev-identity
 * header for the reason that module gives.
 *
 * There is nothing to *write* here. Views and chapter reads are recorded by
 * the API from the read endpoints the app already calls, so the browser never
 * posts an event — which is also why an ad blocker cannot silence them.
 */

import { request } from '../lib/api-client'
import { readerHeaders } from './stories-api'
import type {
  AnalyticsRange,
  AuthorOverview,
  StoryAnalytics,
} from '../types/analytics'

/**
 * Everything both author pages need: the window's totals, the author's
 * lifetime totals, the daily series and a row per story.
 *
 * One request rather than one per tile. The pages used to sum a page of
 * forty-eight stories in the browser, which was neither every story nor an
 * aggregate — and could not answer a per-day question at all.
 */
export async function getOverview(
  range: AnalyticsRange = '30d',
): Promise<AuthorOverview> {
  return request<AuthorOverview>('/author/analytics', {
    headers: readerHeaders(),
    query: { range },
  })
}

/** One story's own series, plus where its reads fell across its chapters. */
export async function getStoryAnalytics(
  storyId: string,
  range: AnalyticsRange = '30d',
): Promise<StoryAnalytics> {
  return request<StoryAnalytics>(
    `/author/analytics/stories/${encodeURIComponent(storyId)}`,
    { headers: readerHeaders(), query: { range } },
  )
}
