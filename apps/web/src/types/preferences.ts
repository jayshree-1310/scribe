/**
 * Reader preference types.
 *
 * These mirror `apps/api/src/services/preferences.ts` exactly, the same way
 * `types/stories.ts` mirrors the stories service.
 */

import type { NotificationType } from './notifications'

export const CONTENT_LENGTHS = ['SHORT', 'MEDIUM', 'LONG', 'ANY'] as const

export type ContentLength = (typeof CONTENT_LENGTHS)[number]

/**
 * What each length is called and what it means, for the one step of onboarding
 * and the one settings row that ask. The word counts are the API's
 * (`LENGTH_BUCKETS`), said in reading time because nobody thinks in words.
 */
export const CONTENT_LENGTH_OPTIONS: Array<{
  id: ContentLength
  label: string
  detail: string
}> = [
  { id: 'SHORT', label: 'Short reads', detail: 'An hour or less — one sitting' },
  { id: 'MEDIUM', label: 'Novellas', detail: 'A few evenings' },
  { id: 'LONG', label: 'Novel-length epics', detail: 'Something to live in' },
  { id: 'ANY', label: 'Anything', detail: "Don't rank me on length" },
]

export const CONTENT_LENGTH_LABELS: Record<ContentLength, string> =
  Object.fromEntries(
    CONTENT_LENGTH_OPTIONS.map((option) => [option.id, option.label]),
  ) as Record<ContentLength, string>

export interface Preferences {
  /** Genre ids, in catalogue order — the API sorts them. */
  genreIds: string[]
  contentLength: ContentLength
  mutedNotificationTypes: NotificationType[]
  /**
   * The flag the app routes on. False for an account that has never been
   * through the flow, which is not the same as one that answered nothing.
   */
  onboardingComplete: boolean
  onboardingCompletedAt: string | null
  /** Null for a reader who has never saved anything. */
  updatedAt: string | null
}

/**
 * Only the keys being changed. A key that is present replaces what was there —
 * `genreIds: []` really does mean "no genres" — and a key that is absent is
 * left alone.
 */
export interface PreferenceUpdate {
  genreIds?: string[]
  contentLength?: ContentLength
  mutedNotificationTypes?: NotificationType[]
  onboardingComplete?: boolean
}
