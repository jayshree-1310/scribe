/**
 * Badge data access.
 *
 * Every function here talks to the real Scribe API through the shared fetch
 * wrapper, so errors arrive as `ApiError` with a message safe to show. Shares
 * `stories-api.ts`'s dev-identity header for the reason that module gives.
 *
 * **Announcing a badge is no longer this module's job.** Until notifications
 * landed there was nowhere to deliver "you earned something" to a reader who
 * was elsewhere when it happened, so `newlyEarnedSince` kept the codes it had
 * already shown in `localStorage` and toasted the difference the next time the
 * badges page loaded. Per browser, per account: a second device announced the
 * same badge again and a cleared store swallowed one. The award is now told by
 * the server as a `BADGE_EARNED` notification, which reaches the reader
 * wherever they are and on every device, so that whole section is gone rather
 * than kept beside a second announcer that would double every toast.
 */

import { request } from '../lib/api-client'
import { readerHeaders } from './stories-api'
import type { BadgeCollection, BadgeProgress } from '../types/gamification'

/** The caller's whole catalogue, with their progress on each badge. */
export async function getBadges(): Promise<BadgeCollection> {
  return request<BadgeCollection>('/badges', { headers: readerHeaders() })
}

/**
 * What somebody else has earned.
 *
 * Only their earned badges come back -- a stranger's progress toward a locked
 * one is a readout of how much they use the site, and the API does not answer
 * it. So there is no "locked" section on somebody else's profile to render.
 */
export async function getUserBadges(username: string): Promise<BadgeProgress[]> {
  const { badges } = await request<{ badges: BadgeProgress[] }>(
    `/users/${encodeURIComponent(username)}/badges`,
    { headers: readerHeaders() },
  )
  return badges
}
