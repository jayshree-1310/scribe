/**
 * Badge data access.
 *
 * Every function here talks to the real Scribe API through the shared fetch
 * wrapper, so errors arrive as `ApiError` with a message safe to show. Shares
 * `stories-api.ts`'s dev-identity header for the reason that module gives.
 */

import { request } from '../lib/api-client'
import { readerHeaders } from './stories-api'
import type { Badge, BadgeCollection, BadgeProgress } from '../types/gamification'

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

/* Announcing a new badge -------------------------------------------------- */

/**
 * Badge codes this browser has already shown the reader.
 *
 * A badge is awarded by whichever event moved its metric -- a comment, a
 * publish, a scroll save -- and the reader is somewhere else entirely when
 * that happens. Until there is a notification system (Task 14 in
 * `docs/BACKLOG.md`), the only moment to tell them is the next time they open
 * the badges page, and the response cannot say which of them the reader has
 * already seen. So the browser remembers.
 *
 * Deliberately per browser and per account, and deliberately *not* treated as
 * authoritative: a cleared store means one missed toast, never a missed badge.
 * When the notification system lands, this whole section is what it replaces.
 */
const SEEN_KEY = 'scribe.badges.seen'

function seenKey(userId: string): string {
  return `${SEEN_KEY}.${userId}`
}

function readSeen(userId: string): string[] | null {
  try {
    const raw = window.localStorage.getItem(seenKey(userId))
    if (raw === null) return null

    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((code) => typeof code === 'string') : null
  } catch {
    // Private mode, blocked site data, or a value somebody else wrote. Either
    // way the reader simply gets no toast.
    return null
  }
}

function writeSeen(userId: string, codes: string[]): void {
  try {
    window.localStorage.setItem(seenKey(userId), JSON.stringify(codes))
  } catch {
    // Storage full or unavailable. Nothing here is worth failing a render for.
  }
}

/**
 * The badges to announce, and a record that they have been announced.
 *
 * Returns nothing the first time an account is seen in this browser: somebody
 * arriving with eleven badges already earned does not want eleven toasts about
 * things they did last month. From then on the difference is what is new.
 */
export function newlyEarnedSince(
  userId: string,
  earned: readonly BadgeProgress[],
): Badge[] {
  const codes = earned.map((entry) => entry.badge.code)
  const seen = readSeen(userId)

  writeSeen(userId, codes)

  if (seen === null) return []

  const known = new Set(seen)
  return earned
    .filter((entry) => !known.has(entry.badge.code))
    .map((entry) => entry.badge)
}
