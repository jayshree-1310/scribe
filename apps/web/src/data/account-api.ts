/**
 * The signed-in reader's own account: profile fields and avatar.
 *
 * `AuthProvider` widens what these return into the `User` the UI renders; the
 * settings form and the profile page never talk to this module directly
 * without going through the session, so there is one copy of the profile in
 * the app rather than two that can disagree.
 */

import { request } from '../lib/api-client'

/** What `/api/account/me` returns — see `apps/api/src/services/account.ts`. */
export interface AccountProfile {
  id: string
  username: string
  email: string
  emailVerified: boolean
  displayName: string | null
  avatarUrl: string | null
  bio: string | null
  isAuthor: boolean
  readingStreak: number
  readerLevel: number
  authorLevel: number
  joinedAt: string
}

/** Only the fields the caller is changing; anything omitted is left alone. */
export interface AccountUpdate {
  username?: string
  email?: string
  displayName?: string
  bio?: string
}

export function getMyAccount(): Promise<AccountProfile> {
  return request<AccountProfile>('/account/me')
}

export function updateMyAccount(update: AccountUpdate): Promise<AccountProfile> {
  return request<AccountProfile>('/account/me', {
    method: 'PATCH',
    body: update,
  })
}

/** Largest image the API accepts, checked here so an obvious reject costs no
 * upload. The API enforces the same ceiling; this is only courtesy. */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024

export const ACCEPTED_AVATAR_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]

/**
 * Sends the file as the request body rather than a multipart form: one field
 * needs no envelope, and the API sniffs the bytes regardless of what the
 * browser calls them.
 */
export function uploadAvatar(file: File): Promise<AccountProfile> {
  return request<AccountProfile>('/account/avatar', {
    method: 'POST',
    body: file,
  })
}

export function removeAvatar(): Promise<AccountProfile> {
  return request<AccountProfile>('/account/avatar', { method: 'DELETE' })
}
