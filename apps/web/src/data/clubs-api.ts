/**
 * Book club data access.
 *
 * Every function here talks to the real Scribe API through the shared fetch
 * wrapper, so errors arrive as `ApiError` with a message safe to show. Shares
 * `stories-api.ts`'s dev-identity header for the reason that module gives: the
 * web app can act as a reader before sign-in is wired everywhere.
 */

import { request } from '../lib/api-client'
import { readerHeaders } from './stories-api'
import type {
  Club,
  ClubDetail,
  ClubMembership,
  ClubPage,
  ClubRole,
  ClubSort,
  Discussion,
  DiscussionPage,
  MemberPage,
} from '../types/clubs'

/* Reads ------------------------------------------------------------------ */

export interface ClubFilters {
  search?: string
  /** Only clubs the caller belongs to. Ignored when signed out. */
  mine?: boolean
  sort?: ClubSort
  page?: number
  limit?: number
}

export async function listClubs(filters: ClubFilters = {}): Promise<ClubPage> {
  return request<ClubPage>('/clubs', {
    headers: readerHeaders(),
    query: {
      search: filters.search?.trim() || undefined,
      // Omitted rather than sent as "false": the API treats the flag's
      // absence as "no filter", and `false` would read the same but says less.
      mine: filters.mine ? 'true' : undefined,
      sort: filters.sort,
      page: filters.page === undefined ? undefined : String(filters.page),
      limit: filters.limit === undefined ? undefined : String(filters.limit),
    },
  })
}

/** One club by slug or by id. */
export async function getClub(slugOrId: string): Promise<ClubDetail> {
  const { club } = await request<{ club: ClubDetail }>(
    `/clubs/${encodeURIComponent(slugOrId)}`,
    { headers: readerHeaders() },
  )
  return club
}

export async function getClubMembers(
  slugOrId: string,
  options: { page?: number; limit?: number } = {},
): Promise<MemberPage> {
  return request<MemberPage>(
    `/clubs/${encodeURIComponent(slugOrId)}/members`,
    {
      headers: readerHeaders(),
      query: {
        page: options.page === undefined ? undefined : String(options.page),
        limit: options.limit === undefined ? undefined : String(options.limit),
      },
    },
  )
}

/**
 * A club's threads, or one thread's replies when `parentId` is given.
 *
 * Threads come back newest first and replies oldest first — a club page leads
 * with what is being answered today, a thread reads in the order it happened.
 */
export async function getClubDiscussions(
  slugOrId: string,
  options: { parentId?: string; page?: number; limit?: number } = {},
): Promise<DiscussionPage> {
  return request<DiscussionPage>(
    `/clubs/${encodeURIComponent(slugOrId)}/discussions`,
    {
      headers: readerHeaders(),
      query: {
        parentId: options.parentId,
        page: options.page === undefined ? undefined : String(options.page),
        limit: options.limit === undefined ? undefined : String(options.limit),
      },
    },
  )
}

/* Writes ----------------------------------------------------------------- */

export interface ClubInput {
  name: string
  description?: string | null
}

export async function createClub(input: ClubInput): Promise<ClubDetail> {
  const { club } = await request<{ club: ClubDetail }>('/clubs', {
    method: 'POST',
    headers: readerHeaders(),
    body: input,
  })
  return club
}

export async function updateClub(
  clubId: string,
  input: Partial<ClubInput>,
): Promise<ClubDetail> {
  const { club } = await request<{ club: ClubDetail }>(
    `/clubs/${encodeURIComponent(clubId)}`,
    { method: 'PATCH', headers: readerHeaders(), body: input },
  )
  return club
}

export async function deleteClub(clubId: string): Promise<void> {
  await request<void>(`/clubs/${encodeURIComponent(clubId)}`, {
    method: 'DELETE',
    headers: readerHeaders(),
  })
}

/** Idempotent: joining a club you are already in succeeds. */
export async function joinClub(clubId: string): Promise<ClubMembership> {
  const { membership } = await request<{ membership: ClubMembership }>(
    `/clubs/${encodeURIComponent(clubId)}/join`,
    { method: 'POST', headers: readerHeaders() },
  )
  return membership
}

/**
 * Idempotent, with one exception the caller has to handle: the club's last
 * owner cannot leave, and the API answers 409 with a message saying so.
 */
export async function leaveClub(clubId: string): Promise<void> {
  await request<void>(`/clubs/${encodeURIComponent(clubId)}/leave`, {
    method: 'DELETE',
    headers: readerHeaders(),
  })
}

export async function setMemberRole(
  clubId: string,
  userId: string,
  role: ClubRole,
): Promise<void> {
  await request<void>(
    `/clubs/${encodeURIComponent(clubId)}/members/${encodeURIComponent(userId)}`,
    { method: 'PATCH', headers: readerHeaders(), body: { role } },
  )
}

export async function removeMember(
  clubId: string,
  userId: string,
): Promise<void> {
  await request<void>(
    `/clubs/${encodeURIComponent(clubId)}/members/${encodeURIComponent(userId)}`,
    { method: 'DELETE', headers: readerHeaders() },
  )
}

/** `null` clears the club's current read. */
export async function setCurrentRead(
  clubId: string,
  storyId: string | null,
): Promise<Club> {
  const { club } = await request<{ club: ClubDetail }>(
    `/clubs/${encodeURIComponent(clubId)}/current-read`,
    { method: 'PUT', headers: readerHeaders(), body: { storyId } },
  )
  return club
}

/** Posts a thread, or a reply when `parentId` is given. Members only. */
export async function postDiscussion(
  clubId: string,
  input: { body: string; parentId?: string },
): Promise<Discussion> {
  const { discussion } = await request<{ discussion: Discussion }>(
    `/clubs/${encodeURIComponent(clubId)}/discussions`,
    { method: 'POST', headers: readerHeaders(), body: input },
  )
  return discussion
}

/** The author of the post, or the club's owner or an admin. */
export async function deleteDiscussion(discussionId: string): Promise<void> {
  await request<void>(
    `/clubs/discussions/${encodeURIComponent(discussionId)}`,
    { method: 'DELETE', headers: readerHeaders() },
  )
}
