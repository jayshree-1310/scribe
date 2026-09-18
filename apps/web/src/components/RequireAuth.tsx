import { Navigate, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '../lib/auth'

/**
 * Gate for signed-in pages. Sends visitors to sign-in and remembers where they
 * were headed, and routes accounts to whichever side of onboarding they belong
 * on.
 *
 * `session.onboarded` mirrors `AccountProfile.onboardingComplete`, which is a
 * column rather than local state — so the redirect survives a reload, a second
 * device and a tab closed halfway through the flow. That is the whole reason
 * the flag moved to the server: the old local copy let a refresh mid-flow
 * carry somebody past a form they had not filled in.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { session } = useAuth()
  const location = useLocation()

  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  const onOnboarding = location.pathname === '/onboarding'

  if (!session.onboarded && !onOnboarding) {
    return <Navigate to="/onboarding" replace />
  }

  // The other direction, and the reason `/onboarding` sits behind this gate at
  // all: somebody who has already answered should not be able to walk back
  // into the flow by typing the URL and re-save their way through it.
  if (session.onboarded && onOnboarding) {
    return <Navigate to="/home" replace />
  }

  return <>{children}</>
}
