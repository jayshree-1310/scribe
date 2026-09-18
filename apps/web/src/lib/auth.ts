/**
 * Client-side session state.
 *
 * Sign-in, registration, the profile the session carries and whether
 * onboarding is finished all come from the API. What is still local is the
 * presentational half of a `User` that the mock supplies -- `AuthProvider`
 * explains which fields and why.
 */

import { createContext, useContext } from 'react'
import type { AccountProfile } from '../data/account-api'
import type { Session, User } from '../types/domain'

export const SESSION_STORAGE_KEY = 'scribe:session'

export interface GoogleSignInResult {
  user: User
  /** True when this sign-in created the account, so it needs onboarding. */
  created: boolean
}

export interface AuthContextValue {
  session: Session | null
  /** True until the stored session has been read. */
  initialising: boolean
  signIn: (input: { email: string; password: string; remember: boolean }) => Promise<User>
  register: (input: {
    username: string
    email: string
    password: string
  }) => Promise<User>
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
