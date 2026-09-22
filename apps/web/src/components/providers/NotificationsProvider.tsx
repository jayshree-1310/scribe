import type { ReactNode } from 'react'
import { useAuth } from '../../lib/auth'
import {
  NotificationsContext,
  useNotificationsSource,
} from '../../hooks/useNotifications'

/**
 * Runs the one notification source the app has, and hands it to everything
 * that draws notifications.
 *
 * Mounted inside `AuthProvider`, because the source only runs for a signed-in
 * reader and asks the session who that is. Everything else about it -- the
 * poll, the reconciling, where the rows come from -- is in
 * `hooks/useNotifications.ts`; this file exists to make sure there is exactly
 * one of it. See that module's header for why two would be worse than none.
 *
 * The value is passed straight through rather than memoised: the source
 * returns a fresh object each render, but this component only renders when
 * that state moves or when something above it does -- and in the second case
 * every consumer below was re-rendering regardless.
 */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth()
  const state = useNotificationsSource(session !== null)

  return (
    <NotificationsContext.Provider value={state}>
      {children}
    </NotificationsContext.Provider>
  )
}
