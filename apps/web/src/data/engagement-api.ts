/**
 * Comment + rating data access.
 *
 * Talks to the real Scribe API through the shared fetch wrapper, so errors
 * arrive as `ApiError` with a message safe to show. Follows the shape of
 * `books-api.ts`.
 *
 * There were no mock functions to replace here: the mock comment and rating
 * helpers had already been deleted from `data/api.ts`, so every caller of this
 * module is new.
 */

import { request } from '../lib/api-client'
import { readerHeaders } from './stories-api'
import type { Comment, CommentPage, RatingSummary } from '../types/engagement'

/* Comments --------------------------------------------------------------- */

export interface CommentFilters {
  /** A thread id lists that thread's replies; omitted lists the threads. */
  parentId?: string
  /** Narrows to one chapter's threads, for the reader's side panel. */
  chapterId?: string
  page?: number
  limit?: number
}

/** A story's comments, newest first. Public — works signed out. */
export async function listComments(
  storyIdOrSlug: string,
  filters: CommentFilters = {},
): Promise<CommentPage> {
  return request<CommentPage>(
    `/stories/${encodeURIComponent(storyIdOrSlug)}/comments`,
    {
      headers: readerHeaders(),
      query: {
        parentId: filters.parentId,
        chapterId: filters.chapterId,
        page: filters.page === undefined ? undefined : String(filters.page),
        limit: filters.limit === undefined ? undefined : String(filters.limit),
      },
    },
  )
}

export interface CommentInput {
  content: string
  /** Attaches the comment to one chapter. Ignored by the API when replying. */
  chapterId?: string
  /** Replies are one level deep: replying to a reply lands on its thread. */
  parentId?: string
}

export async function postComment(
  storyIdOrSlug: string,
  input: CommentInput,
): Promise<Comment> {
  const { comment } = await request<{ comment: Comment }>(
    `/stories/${encodeURIComponent(storyIdOrSlug)}/comments`,
    { method: 'POST', headers: readerHeaders(), body: input },
  )
  return comment
}

/** The comment's own author only; anyone else gets a 403. */
export async function deleteComment(commentId: string): Promise<void> {
  await request<void>(`/comments/${encodeURIComponent(commentId)}`, {
    method: 'DELETE',
    headers: readerHeaders(),
  })
}

/* Ratings ---------------------------------------------------------------- */

/**
 * The average, the count, the 1–5 breakdown and the caller's own score.
 * Public; `mine` is null when signed out.
 */
export async function getRatings(
  storyIdOrSlug: string,
): Promise<RatingSummary> {
  return request<RatingSummary>(
    `/stories/${encodeURIComponent(storyIdOrSlug)}/ratings`,
    { headers: readerHeaders() },
  )
}

/**
 * Records the caller's score, replacing the one they had, and answers the
 * refreshed summary — so a page that just rated redraws from the response
 * rather than re-fetching.
 */
export async function rateStory(
  storyIdOrSlug: string,
  rating: number,
): Promise<RatingSummary> {
  return request<RatingSummary>(
    `/stories/${encodeURIComponent(storyIdOrSlug)}/rating`,
    { method: 'PUT', headers: readerHeaders(), body: { rating } },
  )
}

/** Withdraws the caller's rating. Silent when they had none. */
export async function clearRating(
  storyIdOrSlug: string,
): Promise<RatingSummary> {
  return request<RatingSummary>(
    `/stories/${encodeURIComponent(storyIdOrSlug)}/rating`,
    { method: 'DELETE', headers: readerHeaders() },
  )
}
