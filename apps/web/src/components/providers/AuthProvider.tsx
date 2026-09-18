import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AuthContext, SESSION_STORAGE_KEY } from '../../lib/auth'
import { db } from '../../data/api'
import { getMyAccount, type AccountProfile } from '../../data/account-api'
import {
  registerWithPassword,
  restoreSession,
  signInWithGoogleIdToken,
  signInWithPassword,
  signOutRequest,
} from '../../data/auth-api'
import { requestGoogleIdToken } from '../../lib/google-identity'
import type { Session, User } from '../../types/domain'

/**
 * Widens the account the API returns into the profile shape the UI renders.
 *
 * The API owns identity and the profile fields settings can edit — username,
 * email, display name, bio, avatar — while the presentational fields (hue,
 * follower counts, reading stats) still come from the mock profile, because no
 * endpoint serves them yet. Every sign-in path goes through here, so all of
 * them produce the same shape.
 *
 * `onboardingComplete` deliberately does *not* land on the user: it is a
 * property of the session's routing, not of the person, and it is read from
 * the profile at each of the call sites below.
 */
function toUser(profile: AccountProfile): User {
  return {
    ...db.currentUser,
    id: profile.id,
    username: profile.username,
    email: profile.email,
    displayName: profile.displayName ?? profile.username,
    bio: profile.bio ?? '',
    avatarUrl: profile.avatarUrl,
    isAuthor: profile.isAuthor,
    emailVerified: profile.emailVerified,
    hasPassword: profile.hasPassword,
    joinedAt: profile.joinedAt,
    stats: {
      ...db.currentUser.stats,
      readingStreakDays: profile.readingStreak,
    },
  }
}

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

export function AuthProvider({ children }: { children: ReactNode }) {
  // Read synchronously so protected routes never flash the signed-out state
  // while the stored session is being revalidated against the API below.
  const [session, setSession] = useState<Session | null>(readStoredSession)
  const [initialising, setInitialising] = useState(session !== null)

  const start = useCallback((user: User, onboarded: boolean): Session => {
    const next: Session = { user, onboarded }
    setSession(next)
    persist(next)
    return next
  }, [])

  const signOut = useCallback(() => {
    setSession(null)
    persist(null)
    void signOutRequest()
  }, [])

  /**
   * Rebuilds the session on load. The refresh token is an HttpOnly cookie, so
   * the stored session is only a cache of what it entitles us to: if the
   * cookie is gone or expired, the cached copy has to go with it, or the app
   * shows a signed-in shell whose every request 401s.
   */
  const hasBootstrapped = useRef(false)

  useEffect(() => {
    if (hasBootstrapped.current) return
    hasBootstrapped.current = true

    // No stored session means nothing to revalidate — an anonymous visitor
    // must not have a session minted for them from a stale cookie.
    // `initialising` already starts false in that case, so there is nothing
    // to clear here.
    if (session === null) return

    /**
     * Deliberately no cancellation flag.
     *
     * The ref above already guarantees this runs once, which means the one run
     * has to be allowed to finish. Under StrictMode's development double-mount
     * the first pass would be cancelled by its own cleanup and the second would
     * return early at the guard, leaving `initialising` true for the life of
     * the page — so nothing that waits for the access token ever proceeds.
     */
    void (async () => {
      try {
        const accessToken = await restoreSession()

        if (!accessToken) {
          setSession(null)
          persist(null)
          return
        }

        const profile = await getMyAccount()

        // The API decides whether onboarding is finished, so a reader who
        // closed the tab halfway through is put back into the flow rather
        // than let past it by a stale cached session.
        const next: Session = {
          user: toUser(profile),
          onboarded: profile.onboardingComplete,
        }
        setSession(next)
        persist(next)
      } catch {
        // A transport failure is not proof the session is invalid — dropping
        // it would sign people out every time the network hiccups — so the
        // cached session stands until a request actually comes back 401.
      } finally {
        setInitialising(false)
      }
    })()

    // Runs once; `session` is read for its initial value only, and the ref
    // above keeps a re-run from re-checking.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const signIn = useCallback(
    async ({ email, password }: { email: string; password: string; remember: boolean }) => {
      await signInWithPassword({ email, password })

      const profile = await getMyAccount()
      const user = toUser(profile)
      // Signing in does not mean onboarding was done: an account that never
      // finished it lands back in the flow, wherever it signed in from.
      start(user, profile.onboardingComplete)
      return user
    },
    [start],
  )

  const register = useCallback(
    async (input: { username: string; email: string; password: string }) => {
      await registerWithPassword(input)

      const user = toUser(await getMyAccount())
      // New accounts land in onboarding rather than the feed. No request is
      // needed to know that: nothing has answered anything yet.
      start(user, false)
      return user
    },
    [start],
  )

  /**
   * Google sign-in: Google identifies the visitor in the browser, the API
   * verifies the resulting ID token against Google's keys, and the session it
   * issues is indistinguishable from a password login's.
   *
   * Takes no arguments, as before, so the sign-in and register pages calling
   * it are unchanged. A brand-new account lands in onboarding, matching
   * `register`, while a returning one goes straight in.
   */
  const signInWithGoogle = useCallback(async () => {
    const idToken = await requestGoogleIdToken()
    const { created } = await signInWithGoogleIdToken(idToken)

    const profile = await getMyAccount()
    const user = toUser(profile)
    // A brand-new account has nothing saved and goes to onboarding; a
    // returning one is trusted to the flag the API answers with.
    start(user, created ? false : profile.onboardingComplete)
    return { user, created }
  }, [start])

  /**
   * Called by `OnboardingPage` after the API has been told, so the redirect
   * out of the flow does not bounce off `RequireAuth` while the next
   * `/account/me` is still in flight. Nothing is saved here -- the page saves
   * each step as the reader takes it.
   */
  const completeOnboarding = useCallback(() => {
    setSession((current) => {
      if (!current) return current
      const next: Session = { ...current, onboarded: true }
      persist(next)
      return next
    })
  }, [])

  const adoptProfile = useCallback((profile: AccountProfile) => {
    setSession((current) => {
      if (!current) return current
      const next: Session = {
        ...current,
        user: toUser(profile),
        onboarded: profile.onboardingComplete,
      }
      persist(next)
      return next
    })
  }, [])

  const value = useMemo(
    () => ({
      session,
      initialising,
      signIn,
      register,
      signInWithGoogle,
      completeOnboarding,
      adoptProfile,
      signOut,
    }),
    [
      session,
      initialising,
      signIn,
      register,
      signInWithGoogle,
      completeOnboarding,
      adoptProfile,
      signOut,
    ],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
