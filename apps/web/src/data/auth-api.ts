/**
 * The authentication endpoints.
 *
 * The refresh token never appears here: the API sets it as an HttpOnly cookie
 * scoped to `/api/auth`, so the browser sends it back on these calls and no
 * script — this module included — can read it.
 */

import { request } from '../lib/api-client'
import {
  refreshAccessToken,
  registerTokenRefresher,
  setAccessToken,
} from '../lib/access-token'

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
 * Exchanges the refresh cookie for a new access token. Returns null when there
 * is no live session, which is the ordinary signed-out case rather than an
 * error.
 *
 * Registered with the token store below so that `api-client` can drive it —
 * on a cold load, and again whenever a request comes back 401 — without this
 * module and that one importing each other.
 */
async function requestRefresh(): Promise<string | null> {
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

registerTokenRefresher(requestRefresh)

/**
 * Restores a session on page load. Goes through the shared, de-duplicated
 * refresh so that this and the app's first authed requests — which fire at the
 * same moment — cost one call between them rather than one each.
 */
export async function restoreSession(): Promise<string | null> {
  return refreshAccessToken()
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

/* Passwords and email verification -------------------------------------- */

/**
 * Asks for a reset link.
 *
 * Resolves the same way whether or not that address has an account — the API
 * refuses to say, so the page must not imply otherwise in what it renders
 * afterwards.
 */
export function requestPasswordReset(email: string): Promise<{ message: string }> {
  return request('/auth/forgot-password', { method: 'POST', body: { email } })
}

/**
 * Spends a reset link. No session comes back on purpose: the API revokes
 * every session on a reset, including any an intruder was holding, so the
 * caller signs in with the new password afterwards.
 */
export function resetPassword(input: {
  token: string
  password: string
}): Promise<{ message: string }> {
  return request('/auth/reset-password', { method: 'POST', body: input })
}

/**
 * Changing or setting a password signs out every other device, which means
 * the caller's own session is replaced too — the response carries its
 * successor, and adopting it here is what keeps the page usable afterwards
 * rather than 401-ing on its next request.
 */
export async function changePassword(input: {
  currentPassword: string
  newPassword: string
}): Promise<void> {
  const response = await request<{ accessToken: string }>('/auth/change-password', {
    method: 'POST',
    body: input,
  })

  setAccessToken(response.accessToken)
}

/** For accounts created through Google, which have no password to change. */
export async function setPassword(password: string): Promise<void> {
  const response = await request<{ accessToken: string }>('/auth/set-password', {
    method: 'POST',
    body: { password },
  })

  setAccessToken(response.accessToken)
}

export function sendVerificationEmail(): Promise<{ message: string }> {
  return request('/auth/send-verification', { method: 'POST' })
}

/** Confirms an address from the link in the email. Needs no session. */
export function verifyEmail(token: string): Promise<{ email: string }> {
  return request('/auth/verify-email', { method: 'POST', body: { token } })
}

/** Ends every session this account has, on every device. */
export async function signOutEverywhere(): Promise<void> {
  try {
    await request('/auth/logout-all', { method: 'POST' })
  } finally {
    setAccessToken(null)
  }
}
