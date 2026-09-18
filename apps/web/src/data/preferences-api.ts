/**
 * Reader preference data access.
 *
 * Talks to the real Scribe API through the shared fetch wrapper, so errors
 * arrive as `ApiError` with a message safe to show. Shares `stories-api.ts`'s
 * dev-identity header for the reason that module gives.
 *
 * Distinct from `account-api.ts`, which sits under the same prefix and serves
 * the profile: the two are separate routers behind separate services, and the
 * session only carries one field from here — `onboardingComplete`, which the
 * profile endpoint reports so the app can route without a second request.
 */

import { request } from '../lib/api-client'
import { readerHeaders } from './stories-api'
import type { Preferences, PreferenceUpdate } from '../types/preferences'

export async function getPreferences(): Promise<Preferences> {
  const { preferences } = await request<{ preferences: Preferences }>(
    '/account/preferences',
    { headers: readerHeaders() },
  )
  return preferences
}

/**
 * Saves the keys given and leaves the rest alone. Sending a list replaces it,
 * so `{ genreIds: [] }` clears the genres rather than doing nothing.
 */
export async function savePreferences(
  update: PreferenceUpdate,
): Promise<Preferences> {
  const { preferences } = await request<{ preferences: Preferences }>(
    '/account/preferences',
    { method: 'PUT', headers: readerHeaders(), body: update },
  )
  return preferences
}
