/**
 * Beta reader types.
 *
 * These mirror the API responses in `apps/api/src/services/beta.ts` exactly.
 * An author shares unpublished chapters through a private link; the readers
 * who join can read them and leave feedback only the author sees.
 */

import type { Story } from './stories'

/** Mirrors the API's `FEEDBACK_LIMIT`. */
export const BETA_FEEDBACK_LIMIT = 4000

export interface BetaPerson {
  id: string
  username: string
  displayName: string | null
  avatarUrl: string | null
}

export interface BetaLink {
  token: string
  createdAt: string
}

export interface BetaReaderSummary {
  user: BetaPerson
  joinedAt: string
  feedbackCount: number
}

export interface BetaOverview {
  storyId: string
  link: BetaLink | null
  readers: BetaReaderSummary[]
}

export interface BetaInvite {
  story: Story
  isAuthor: boolean
  joined: boolean
}

export interface BetaFeedback {
  id: string
  storyId: string
  chapterId: string
  chapterNumber: number
  chapterTitle: string
  /** Whether the chapter is published now, not when this was written. */
  chapterPublished: boolean
  body: string
  /** The passage it is about, as the chapter read when it was written. */
  quote: string | null
  reader: BetaPerson
  /** Written by the caller, who may edit it. */
  mine: boolean
  createdAt: string
  updatedAt: string
}

/** The full invite URL for a token, on whatever origin the app is served from. */
export function betaInviteUrl(token: string): string {
  return `${window.location.origin}/beta/${token}`
}

export function betaPersonName(person: BetaPerson): string {
  return person.displayName ?? `@${person.username}`
}
