/**
 * Writing challenge data access.
 *
 * Every function here talks to the real Scribe API through the shared fetch
 * wrapper, so errors arrive as `ApiError` with a message safe to show. Shares
 * `stories-api.ts`'s dev-identity header for the reason that module gives: the
 * web app can act as a reader before sign-in is wired everywhere.
 *
 * There is no create or edit function. Hosting a challenge is an administrator
 * action (`POST` / `PATCH /api/challenges`), and nothing in the reader-facing
 * app calls it — see the note in `pages/ChallengesPage.tsx`.
 */

import { request } from '../lib/api-client'
import { readerHeaders } from './stories-api'
import type {
  Challenge,
  ChallengeBoard,
  ChallengeDetail,
  ChallengeEntry,
  LeaderboardPage,
} from '../types/challenges'

/* Reads ------------------------------------------------------------------ */

/**
 * Every challenge, already split by state.
 *
 * One request for all three groups rather than one per tab: the page shows a
 * count on each tab, and three counts cannot be read off a single page of one
 * of them.
 */
export async function getChallenges(): Promise<ChallengeBoard> {
  return request<ChallengeBoard>('/challenges', { headers: readerHeaders() })
}

/** One challenge by slug or by id, with the caller's own entry when they have one. */
export async function getChallenge(slugOrId: string): Promise<ChallengeDetail> {
  const { challenge } = await request<{ challenge: ChallengeDetail }>(
    `/challenges/${encodeURIComponent(slugOrId)}`,
    { headers: readerHeaders() },
  )
  return challenge
}

export async function getLeaderboard(
  slugOrId: string,
  options: { page?: number; limit?: number } = {},
): Promise<LeaderboardPage> {
  return request<LeaderboardPage>(
    `/challenges/${encodeURIComponent(slugOrId)}/leaderboard`,
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

/**
 * Takes a place in a challenge.
 *
 * Not idempotent, unlike joining a club: a second call answers 409 because
 * "you are already entered" is a distinct thing to say rather than a button to
 * redraw. Entering outside the window is a 409 too.
 */
export async function enterChallenge(challengeId: string): Promise<ChallengeEntry> {
  const { entry } = await request<{ entry: ChallengeEntry }>(
    `/challenges/${encodeURIComponent(challengeId)}/enter`,
    { method: 'POST', headers: readerHeaders() },
  )
  return entry
}

/**
 * Attaches, swaps or clears the story on the caller's entry, and edits its
 * note. An omitted field is left alone; `storyId: null` clears it.
 */
export async function updateEntry(
  entryId: string,
  input: { storyId?: string | null; note?: string | null },
): Promise<ChallengeEntry> {
  const { entry } = await request<{ entry: ChallengeEntry }>(
    `/challenges/entries/${encodeURIComponent(entryId)}`,
    { method: 'PUT', headers: readerHeaders(), body: input },
  )
  return entry
}

/** Withdraws. Allowed only while the challenge is open; 409 once it has closed. */
export async function withdrawEntry(entryId: string): Promise<void> {
  await request<void>(`/challenges/entries/${encodeURIComponent(entryId)}`, {
    method: 'DELETE',
    headers: readerHeaders(),
  })
}

/* Hosting ---------------------------------------------------------------- */

/**
 * What a host supplies. `startsAt` / `endsAt` are ISO strings with an offset,
 * which is what the API's schema demands and what a `datetime-local` input
 * does *not* produce -- the form converts.
 */
export interface ChallengeDraft {
  title: string
  prompt: string
  description?: string | null
  wordTarget?: number | null
  startsAt: string
  endsAt: string
}

/**
 * Creates a challenge. Administrators only; anybody else gets a 403 from the
 * server whatever the browser believes about itself.
 */
export async function createChallenge(
  draft: ChallengeDraft,
): Promise<Challenge> {
  const { challenge } = await request<{ challenge: Challenge }>('/challenges', {
    method: 'POST',
    headers: readerHeaders(),
    body: draft,
  })

  return challenge
}

/**
 * Edits one. Partial: every field is optional and an empty body is refused,
 * so the form sends only what changed.
 */
export async function updateChallenge(
  id: string,
  changes: Partial<ChallengeDraft>,
): Promise<Challenge> {
  const { challenge } = await request<{ challenge: Challenge }>(
    `/challenges/${encodeURIComponent(id)}`,
    { method: 'PATCH', headers: readerHeaders(), body: changes },
  )

  return challenge
}
