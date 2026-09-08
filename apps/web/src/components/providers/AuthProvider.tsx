import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  AuthContext,
  PASSWORD_MIN,
  SESSION_STORAGE_KEY,
  isValidEmail,
  isValidUsername,
  type OnboardingAnswers,
} from '../../lib/auth'
import { db } from '../../data/api'
import type { Session, User } from '../../types/domain'

function readStoredSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Session
    return parsed?.user?.id ? parsed : null
  } catch {
    return null
  }
}

function persist(session: Session | null): void {
  try {
    if (session) localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
    else localStorage.removeItem(SESSION_STORAGE_KEY)
  } catch {
    // Non-fatal: the session simply won't survive a reload.
  }
}

const NETWORK_DELAY = 700

function wait(ms = NETWORK_DELAY): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // Read synchronously so protected routes never flash the signed-out state.
  const [session, setSession] = useState<Session | null>(readStoredSession)

  const start = useCallback((user: User, onboarded: boolean): Session => {
    const next: Session = {
      user,
      onboarded,
      favoriteGenreIds: [],
      followedAuthorIds: [],
      wantsToWrite: false,
    }
    setSession(next)
    persist(next)
    return next
  }, [])

  const signIn = useCallback(
    async ({ email, password }: { email: string; password: string; remember: boolean }) => {
      await wait()

      if (!isValidEmail(email) || password.length < PASSWORD_MIN) {
        throw new Error(
          "We couldn't sign you in with those details. Check your email and password and try again.",
        )
      }

      const user = { ...db.currentUser, email: email.trim() }
      start(user, true)
      return user
    },
    [start],
  )

  const register = useCallback(
    async ({
      username,
      email,
      password,
    }: {
      username: string
      email: string
      password: string
    }) => {
      await wait()

      if (!isValidUsername(username)) {
        throw new Error('Usernames are 3–24 letters, numbers or underscores.')
      }
      if (!isValidEmail(email)) throw new Error('That email address does not look right.')
      if (password.length < PASSWORD_MIN) {
        throw new Error(`Passwords need at least ${PASSWORD_MIN} characters.`)
      }

      const user: User = {
        ...db.currentUser,
        username: username.trim(),
        displayName: username.trim(),
        email: email.trim(),
        isAuthor: false,
        bio: '',
      }
      // New accounts land in onboarding rather than the feed.
      start(user, false)
      return user
    },
    [start],
  )

  const signInWithGoogle = useCallback(async () => {
    await wait(900)
    const user = db.currentUser
    start(user, true)
    return user
  }, [start])

  const completeOnboarding = useCallback((answers: OnboardingAnswers) => {
    setSession((current) => {
      if (!current) return current
      const next: Session = {
        ...current,
        onboarded: true,
        favoriteGenreIds: answers.favoriteGenreIds,
        followedAuthorIds: answers.followedAuthorIds,
        wantsToWrite: answers.wantsToWrite,
        user: { ...current.user, isAuthor: current.user.isAuthor || answers.wantsToWrite },
      }
      persist(next)
      return next
    })
  }, [])

  const signOut = useCallback(() => {
    setSession(null)
    persist(null)
  }, [])

  const value = useMemo(
    () => ({
      session,
      initialising: false,
      signIn,
      register,
      signInWithGoogle,
      completeOnboarding,
      signOut,
    }),
    [session, signIn, register, signInWithGoogle, completeOnboarding, signOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
