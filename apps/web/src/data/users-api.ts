/**
 * Public profile and follow data access.
 *
 * Talks to the real Scribe API through the shared fetch wrapper, so errors
 * arrive as `ApiError` with a message safe to show. Shares `stories-api.ts`'s
 * dev-identity header for the reason that module gives: the web app can act as
 * a reader before sign-in is wired everywhere — and here it decides both whose
 * drafts come back and whether the Follow button knows its own state.
 *
 * Distinct from `account-api.ts`, which serves the signed-in reader their own
 * account. These endpoints are what anybody may see about anybody.
 */

import { request } from '../lib/api-client'
import { readerHeaders } from './stories-api'
import type { StoryPage } from '../types/stories'
import type { FollowPage, FollowState, PublicProfile } from '../types/users'

/* Reads ------------------------------------------------------------------ */

export async function getProfile(username: string): Promise<PublicProfile> {
  const { profile } = await request<{ profile: PublicProfile }>(
    `/users/${encodeURIComponent(username)}`,
    { headers: readerHeaders() },
  )
  return profile
}

/**
 * One author's stories, newest first. Their own drafts come back too when they
 * are the caller, which is what makes the signed-in view of `/profile` differ
 * from the public one without a second endpoint.
 */
export async function listUserStories(
  username: string,
  options: { page?: number; limit?: number } = {},
): Promise<StoryPage> {
  return request<StoryPage>(
    `/users/${encodeURIComponent(username)}/stories`,
    {
      headers: readerHeaders(),
      query: {
        page: options.page === undefined ? undefined : String(options.page),
        limit: options.limit === undefined ? undefined : String(options.limit),
      },
    },
  )
}

export async function listFollowers(
  username: string,
  options: { page?: number; limit?: number } = {},
): Promise<FollowPage> {
  return request<FollowPage>(
    `/users/${encodeURIComponent(username)}/followers`,
    {
      headers: readerHeaders(),
      query: {
        page: options.page === undefined ? undefined : String(options.page),
        limit: options.limit === undefined ? undefined : String(options.limit),
      },
    },
  )
}

export async function listFollowing(
  username: string,
  options: { page?: number; limit?: number } = {},
): Promise<FollowPage> {
  return request<FollowPage>(
    `/users/${encodeURIComponent(username)}/following`,
    {
      headers: readerHeaders(),
      query: {
        page: options.page === undefined ? undefined : String(options.page),
        limit: options.limit === undefined ? undefined : String(options.limit),
      },
    },
  )
}

/* Writes ----------------------------------------------------------------- */

/** Idempotent: following somebody you already follow succeeds. */
export async function followUser(username: string): Promise<FollowState> {
  return request<FollowState>(`/users/${encodeURIComponent(username)}/follow`, {
    method: 'POST',
    headers: readerHeaders(),
  })
}

/** Idempotent: unfollowing a stranger succeeds rather than 404ing. */
export async function unfollowUser(username: string): Promise<FollowState> {
  return request<FollowState>(`/users/${encodeURIComponent(username)}/follow`, {
    method: 'DELETE',
    headers: readerHeaders(),
  })
}
