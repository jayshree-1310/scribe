/**
 * Client-side session state.
 *
 * Everything the session carries now comes from the API. It used to be half a
 * fiction: `AuthProvider` spread a mock profile under the real one so that an
 * avatar hue, follower counts and a block of reading aggregates had *some*
 * value, because `auth.User` has no columns for them. Task 17 removed the mock
 * layer, and with it the widening -- so the session's user is the account
 * endpoint's own response and nothing else.
 *
 * `Session` lives here rather than in `types/` because it is not an API shape:
 * it is a user plus the one routing bit `RequireAuth` reads. Every type in
 * `types/` mirrors a service response, and a client-only wrapper among them
 * would read as one.
 */

import { createContext, useContext } from 'react'
import type { AccountProfile } from '../data/account-api'

export const SESSION_STORAGE_KEY = 'scribe:session'

/**
 * The signed-in reader, exactly as `GET /api/account/me` answers.
 *
 * Aliased rather than re-declared so there is one hand-written copy of the
 * shape in the app, next to the request that returns it -- see
 * `data/account-api.ts`, which is the source of truth for every field.
 */
export type SessionUser = AccountProfile

/**
 * The signed-in user, and whether they have been through onboarding.
 *
 * The onboarding *answers* used to live here -- genres, followed authors, a
 * "do you write?" flag -- and were thrown away on every reload because nothing
 * persisted them. They are rows now (`auth.UserPreference` and the follow
 * graph), read through `data/preferences-api.ts` by the two surfaces that
 * care. What is left is the one bit `RequireAuth` routes on, mirrored from
 * `AccountProfile.onboardingComplete` so a redirect costs no request.
 */
export interface Session {
  user: SessionUser
  onboarded: boolean
}

export interface GoogleSignInResult {
  user: SessionUser
  /** True when this sign-in created the account, so it needs onboarding. */
  created: boolean
}

export interface AuthContextValue {
  session: Session | null
  /** True until the stored session has been read. */
  initialising: boolean
  signIn: (input: {
    email: string
    password: string
    remember: boolean
  }) => Promise<SessionUser>
  register: (input: {
    username: string
    email: string
    password: string
  }) => Promise<SessionUser>
  signInWithGoogle: () => Promise<GoogleSignInResult>
  /**
   * Records locally that the flow is finished, once the API has been told.
   *
   * `OnboardingPage` owns the saving -- every step of it writes through
   * `data/preferences-api.ts` as the reader advances, so a refresh resumes --
   * and calls this afterwards so the session agrees without waiting for the
   * next `/account/me`. The server's `onboardingComplete` is the truth; this
   * only stops `RequireAuth` bouncing the reader straight back into the flow
   * they just finished.
   */
  completeOnboarding: () => void
  /**
   * Folds a freshly saved profile back into the session, so the avatar in the
   * top bar and the name on the profile page change the moment settings are
   * saved rather than on the next reload.
   */
  adoptProfile: (profile: AccountProfile) => void
  signOut: () => void
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>.')
  return context
}

/* Validation shared by the sign-in and registration forms ---------------- */

export const PASSWORD_MIN = 8

export interface PasswordRule {
  id: string
  label: string
  test: (value: string) => boolean
}

export const PASSWORD_RULES: PasswordRule[] = [
  { id: 'length', label: `At least ${PASSWORD_MIN} characters`, test: (v) => v.length >= PASSWORD_MIN },
  { id: 'case', label: 'An upper and lower case letter', test: (v) => /[a-z]/.test(v) && /[A-Z]/.test(v) },
  { id: 'number', label: 'A number', test: (v) => /\d/.test(v) },
  { id: 'symbol', label: 'A symbol (!, ?, #…)', test: (v) => /[^\w\s]/.test(v) },
]

export function passwordStrength(value: string): {
  score: number
  label: string
  passed: string[]
} {
  const passed = PASSWORD_RULES.filter((rule) => rule.test(value)).map((rule) => rule.id)
  const score = passed.length

  const label =
    value.length === 0
      ? 'Enter a password'
      : score <= 1
        ? 'Too weak'
        : score === 2
          ? 'Getting there'
          : score === 3
            ? 'Strong'
            : 'Very strong'

  return { score, label, passed }
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim())
}

export function isValidUsername(value: string): boolean {
  return /^[a-z0-9_]{3,24}$/i.test(value.trim())
}
