/**
 * The bell's data, and the one place notifications arrive from.
 *
 * **The transport seam.** Notifications are pulled on an interval today. That
 * is the wrong shape for the feature and the right shape for now: a poll is a
 * handful of lines with no connection to keep alive, no reconnect logic and no
 * server push to build, and the thing being delayed is a badge on a bell.
 *
 * Everything that knows it is a poll is in `subscribe` below. It is handed a
 * callback and returns a teardown -- exactly the contract an `EventSource` or
 * a websocket has -- so replacing the transport is replacing that function and
 * nothing else. What must *not* happen is a component growing its own
 * `setInterval`, because that is what makes the switch a search across the app
 * rather than one edit. Everything else here is about what a notification list
 * looks like, and will be as true over a socket as it is over a poll.
 *
 * When that day comes: `POLL_INTERVAL_MS` and the interval go, `subscribe`
 * opens the stream, and each pushed message calls `refresh()`. The reconciling
 * below already assumes rows can arrive at any moment.
 *
 * **One instance, two readers.** `useNotificationsSource` is run once, by
 * `NotificationsProvider`, and everything else reads it through
 * `useNotifications()`. That is not tidiness: the bell and `NotificationsPage`
 * are on screen together, and two instances would mean two polls and two
 * unread counts, so marking a page of notifications read would leave the bell
 * claiming a number that nothing on screen agreed with for up to a minute.
 * The page keeps its own paginated list -- that is genuinely its own -- but
 * delegates every *write* here, so the count and the requests have one home
 * and the page only ever mirrors the result onto its own rows. That is what
 * the booleans the three actions resolve to are for: a mirror has to know when
 * the thing it mirrors rolled back.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  clearReadNotifications,
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../data/notifications-api'
import type { Notification } from '../types/notifications'

/**
 * How often the list is re-read.
 *
 * Sixty seconds is slow enough that an idle tab is not a load-bearing part of
 * the API's traffic, and fast enough that somebody watching for a reply does
 * not reach for the refresh button. It is only a floor on lateness: the list
 * is re-read on open too, so acting on the bell always shows current data.
 */
const POLL_INTERVAL_MS = 60_000

/** How many the dropdown holds. Older ones need the list, not the bell. */
const DROPDOWN_LIMIT = 12

/**
 * Calls `onChange` whenever there might be something new.
 *
 * The whole of what makes this a poll. See the module header: swapping in SSE
 * or a websocket is rewriting this function and changing nothing else, because
 * its contract -- take a callback, return a teardown -- is the one both
 * transports already have.
 */
function subscribe(onChange: () => void): () => void {
  const timer = window.setInterval(onChange, POLL_INTERVAL_MS)
  return () => window.clearInterval(timer)
}

export interface NotificationsState {
  items: Notification[]
  unreadCount: number
  /** True only on the very first load, so the bell does not flicker on a poll. */
  loading: boolean
  /** Set when the last read failed; the bell stays usable regardless. */
  error: string | null
  /** Re-reads now. Called on open, and by `subscribe` on its interval. */
  refresh: () => void
  /**
   * Each resolves to whether the write survived the server, so a second list
   * showing the same rows can roll its own copy back. Never rejects: a failed
   * notification write is not an error anybody needs thrown at them.
   */
  markRead: (id: string) => Promise<boolean>
  markAllRead: () => Promise<boolean>
  /** Deletes the read ones. Unread rows are left alone; see the API service. */
  clearRead: () => Promise<boolean>
  /** True when there is something for `clearRead` to remove. */
  hasRead: boolean
}

/**
 * Notifications for the signed-in reader, or an empty, inert state when there
 * is nobody signed in.
 *
 * `enabled` rather than a null return so the hook's shape does not change with
 * the session -- the bell renders either way, and a component that had to
 * branch on "is there a hook result" would be branching in render.
 *
 * Called once, by `NotificationsProvider`. Components want `useNotifications`
 * below; see the module header for why there is only ever one of these.
 */
export function useNotificationsSource(enabled: boolean): NotificationsState {
  const [items, setItems] = useState<Notification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * Guards against a slow response landing after a newer one, which a poll on
   * a flaky connection produces routinely: two reads in flight, the first
   * answering second, and the list going backwards.
   */
  const latest = useRef(0)
  /** Whether anything has loaded yet, so `loading` is a first-load-only flag. */
  const loaded = useRef(false)

  const refresh = useCallback(() => {
    if (!enabled) return

    const attempt = latest.current + 1
    latest.current = attempt

    if (!loaded.current) setLoading(true)

    getNotifications({ limit: DROPDOWN_LIMIT })
      .then((page) => {
        if (attempt !== latest.current) return

        setItems(page.items)
        setUnreadCount(page.unreadCount)
        setError(null)
        loaded.current = true
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (attempt !== latest.current) return

        /**
         * A failed poll is not worth showing anybody: the bell keeps whatever
         * it had, which is at most a minute stale. The message is held for the
         * dropdown, where somebody who opened it deliberately deserves to know
         * the list did not load.
         */
        setError(cause instanceof Error ? cause.message : 'Notifications are unavailable.')
        setLoading(false)
      })
  }, [enabled])

  /**
   * Signing in or out empties the bell at once, rather than leaving the
   * previous reader's notifications on screen until something reloads.
   *
   * Done during render rather than in an effect -- the pattern React
   * recommends for state derived from inputs, and the one `useAsync` uses for
   * the same job. An effect would paint the old reader's list for a frame
   * first, which is exactly the frame that matters here.
   */
  const [active, setActive] = useState(enabled)
  if (active !== enabled) {
    setActive(enabled)
    setItems([])
    setUnreadCount(0)
    setError(null)
  }

  useEffect(() => {
    if (!enabled) {
      // A ref, so this is not a render-phase write: it only decides whether
      // the *next* first load counts as a first load.
      loaded.current = false
      return
    }

    refresh()
    return subscribe(refresh)
  }, [enabled, refresh])

  /**
   * Marks one read optimistically, and rolls back if the server disagrees.
   *
   * Optimistic because this fires on the click that also navigates away: a
   * reader who waited for the round trip would watch the row stay bold as the
   * page changed under it.
   */
  const markRead = useCallback((id: string): Promise<boolean> => {
    let rolledBack = false

    setItems((current) =>
      current.map((item) =>
        item.id === id && item.readAt === null
          ? { ...item, readAt: new Date().toISOString() }
          : item,
      ),
    )
    setUnreadCount((count) => Math.max(0, count - 1))

    return markNotificationRead(id)
      // The server's count, not ours: it knows about rows this browser has
      // never seen, and a poll arriving mid-click would otherwise leave the
      // two disagreeing until the next one.
      .then((count) => {
        if (!rolledBack) setUnreadCount(count)
        return true
      })
      .catch(() => {
        rolledBack = true
        setItems((current) =>
          current.map((item) =>
            item.id === id ? { ...item, readAt: null } : item,
          ),
        )
        setUnreadCount((count) => count + 1)
        return false
      })
  }, [])

  const markAllRead = useCallback((): Promise<boolean> => {
    const previous = items

    setItems((current) =>
      current.map((item) =>
        item.readAt === null
          ? { ...item, readAt: new Date().toISOString() }
          : item,
      ),
    )
    setUnreadCount(0)

    return markAllNotificationsRead()
      .then((count) => {
        setUnreadCount(count)
        return true
      })
      .catch(() => {
        setItems(previous)
        // Re-read rather than restoring a remembered number: the rollback is
        // the one moment this browser knows least about what the server holds.
        refresh()
        return false
      })
  }, [items, refresh])

  /**
   * Drops the read rows optimistically, and re-reads if the server disagrees.
   *
   * The rollback is a `refresh()` rather than a restore of `previous`, unlike
   * `markRead`'s: a failed delete may have removed some rows and not others,
   * so the browser's copy of the list is the one thing that definitely is not
   * the truth. `markAllRead` rolls back the same way and for the same reason.
   */
  const clearRead = useCallback((): Promise<boolean> => {
    setItems((current) => current.filter((item) => item.readAt === null))

    return clearReadNotifications()
      .then((count) => {
        setUnreadCount(count)
        return true
      })
      .catch(() => {
        refresh()
        return false
      })
  }, [refresh])

  return {
    items,
    unreadCount,
    loading,
    error,
    refresh,
    markRead,
    markAllRead,
    clearRead,
    hasRead: items.some((item) => item.readAt !== null),
  }
}

/**
 * The shared state, provided by `NotificationsProvider`.
 *
 * Null rather than a default value so that reading it outside the provider is
 * a thrown error rather than a bell that silently never fills -- the same
 * bargain `useAuth` makes.
 */
export const NotificationsContext = createContext<NotificationsState | null>(null)

/** The bell's state, for anything rendering notifications. */
export function useNotifications(): NotificationsState {
  const context = useContext(NotificationsContext)
  if (!context) {
    throw new Error('useNotifications must be used inside <NotificationsProvider>.')
  }

  return context
}
