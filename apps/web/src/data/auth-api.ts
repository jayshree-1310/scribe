/**
 * The authentication endpoints.
 *
 * The refresh token never appears here: the API sets it as an HttpOnly cookie
 * scoped to `/api/auth`, so the browser sends it back on these calls and no
 * script — this module included — can read it.
 */

import { request } from '../lib/api-client'
import { setAccessToken } from '../lib/access-token'

/** The user fields the auth endpoints return. */
export interface AuthUser {
  id: string
  username: string
  email: string
  displayName: string | null
  avatarUrl: string | null
}

export interface AuthResult {
  user: AuthUser
  /** True the first time an account is created, so the UI can onboard. */
  created: boolean
}

interface AuthResponse {
  accessToken: string
  created?: boolean
  user: AuthUser
}

function adopt(response: AuthResponse): AuthResult {
  setAccessToken(response.accessToken)
  return { user: response.user, created: response.created ?? false }
}

/** Signs in with an email and password. */
export async function signInWithPassword(input: {
  email: string
  password: string
}): Promise<AuthResult> {
  return adopt(
    await request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: input,
    }),
  )
}

/**
 * Creates an account. Signup does not issue a session — the API answers 201
 * with the new user and nothing else — so this signs in straight afterwards
 * with the same credentials, and reports the account as newly created so the
 * caller can route it into onboarding.
 */
export async function registerWithPassword(input: {
  username: string
  email: string
  password: string
}): Promise<AuthResult> {
  await request('/auth/signup', { method: 'POST', body: input })

  const result = await signInWithPassword({
    email: input.email,
    password: input.password,
  })

  return { ...result, created: true }
}

/** Exchanges a Google ID token for a Scribe session. */
export async function signInWithGoogleIdToken(idToken: string): Promise<AuthResult> {
  return adopt(
    await request<AuthResponse>('/auth/google', {
      method: 'POST',
      body: { idToken },
    }),
  )
}

/**
 * Restores a session on page load from the refresh cookie. Returns null when
 * there is no live session, which is the ordinary signed-out case rather than
 * an error.
 */
export async function restoreSession(): Promise<string | null> {
  try {
    const response = await request<{ accessToken: string }>('/auth/refresh', {
      method: 'POST',
    })
    setAccessToken(response.accessToken)
    return response.accessToken
  } catch {
    setAccessToken(null)
    return null
  }
}

/** Ends the session server-side and clears the refresh cookie. */
export async function signOutRequest(): Promise<void> {
  try {
    await request('/auth/logout', { method: 'POST' })
  } catch {
    // Logout is idempotent server-side; a failure here must not trap the user
    // in a signed-in UI, so the caller clears local state regardless.
  } finally {
    setAccessToken(null)
  }
}
