/**
 * Client-side session state.
 *
 * Sign-in, registration and the profile the session carries all come from the
 * API; what is still local is the onboarding answers and the presentational
 * fields the mock supplies (`AuthProvider` explains which).
 */

import { createContext, useContext } from 'react'
import type { AccountProfile } from '../data/account-api'
import type { Session, User } from '../types/domain'

export const SESSION_STORAGE_KEY = 'scribe:session'

export interface OnboardingAnswers {
  favoriteGenreIds: string[]
  followedAuthorIds: string[]
  interests: string[]
  wantsToWrite: boolean
}

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
  completeOnboarding: (answers: OnboardingAnswers) => void
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
