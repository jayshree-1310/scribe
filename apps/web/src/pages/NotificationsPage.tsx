import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { NotificationRow } from '../components/notifications/NotificationRow'
import { Button } from '../components/ui/Button'
import { EmptyState, ErrorState } from '../components/ui/States'
import { Icon } from '../components/ui/Icon'
import { Skeleton } from '../components/ui/Skeleton'
import { SegmentedControl } from '../components/ui/Tabs'
import { useNotifications } from '../hooks/useNotifications'
import { getNotifications } from '../data/notifications-api'
import type { Notification } from '../types/notifications'
import './notifications-page.css'

/**
 * Everything the bell is too small to hold.
 *
 * The dropdown shows the newest twelve, which is a week at most for anybody
 * with a club; this is where the rest of them are. It shares the account's
 * unread count and all three write actions with the bell through
 * `useNotifications` -- see that module's header -- and owns only the one
 * thing the bell does not have: a list that pages backwards.
 *
 * That list accumulates across "Load older" rather than paging back and forth,
 * shaped after `ChannelDetailPage`'s feed, and for the same reason: a stream of
 * things that happened reads as one wall, and page numbers over a list that
 * grows from the top would move rows under the reader anyway.
 */

/** Matches the API's own default. A notification row is tall; twenty fills a screen. */
const PAGE_SIZE = 20

type Filter = 'all' | 'unread'

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
] as const satisfies ReadonlyArray<{ value: Filter; label: string }>

export function NotificationsPage() {
  const navigate = useNavigate()
  const { unreadCount, markRead, markAllRead, clearRead } = useNotifications()

  const [filter, setFilter] = useState<Filter>('all')

  /**
   * The page's own list. Hand-rolled rather than `useAsync` because it
   * accumulates: the reset on a filter change happens during render, so a page
   * in flight for "all" can never be appended to the unread list.
   */
  const [query, setQuery] = useState({ filter, page: 1 })
  const [loaded, setLoaded] = useState<Notification[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)

  if (query.filter !== filter) {
    setQuery({ filter, page: 1 })
    setLoaded([])
    setHasMore(false)
    setStatus('loading')
    setError(null)
  }

  useEffect(() => {
    let active = true

    getNotifications({
      page: query.page,
      limit: PAGE_SIZE,
      unread: query.filter === 'unread',
    })
      .then((page) => {
        if (!active) return

        setLoaded((current) =>
          query.page === 1 ? page.items : [...current, ...page.items],
        )
        setHasMore(page.hasMore)
        setStatus('ready')
        setError(null)
      })
      .catch((cause: unknown) => {
        if (!active) return

        setStatus('error')
        setError(
          cause instanceof Error
            ? cause.message
            : 'Your notifications did not load.',
        )
      })

    return () => {
      active = false
    }
  }, [query])

  function reload() {
    setStatus('loading')
    setError(null)
    setQuery((current) => ({ ...current, page: 1 }))
    setLoaded([])
  }

  /**
   * Every write below delegates to the shared action and then mirrors the
   * result onto this list. The action owns the request and the unread count;
   * this owns the rows on screen. When it reports a rollback, the mirror is
   * undone the only way it safely can be -- by re-reading, since a failed
   * sweep may have changed some rows and not others.
   */
  function onOpen(notification: Notification): void {
    if (notification.readAt === null) {
      const at = new Date().toISOString()
      setLoaded((current) =>
        current.map((item) =>
          item.id === notification.id ? { ...item, readAt: at } : item,
        ),
      )

      void markRead(notification.id).then((stuck) => {
        if (stuck) return
        setLoaded((current) =>
          current.map((item) =>
            item.id === notification.id ? { ...item, readAt: null } : item,
          ),
        )
      })
    }

    navigate(notification.href)
  }

  function onMarkAllRead(): void {
    const at = new Date().toISOString()
    setLoaded((current) =>
      current.map((item) => (item.readAt === null ? { ...item, readAt: at } : item)),
    )

    void markAllRead().then((stuck) => {
      // The unread filter's whole list just became empty, and on a rollback it
      // did not. Either way the server is the only thing that knows.
      if (!stuck || filter === 'unread') reload()
    })
  }

  function onClearRead(): void {
    setLoaded((current) => current.filter((item) => item.readAt === null))

    void clearRead().then((stuck) => {
      if (!stuck) reload()
    })
  }

  /**
   * Read rows to delete, counted on what is loaded rather than account-wide:
   * there is no endpoint that answers "have I any read notifications", and
   * offering the action for rows nobody has scrolled to would be guessing.
   */
  const hasRead = loaded.some((item) => item.readAt !== null)

  return (
    <>
      <header className="notifs__head">
        <div>
          <h1 className="notifs__title">Notifications</h1>
          <p className="notifs__sub">
            {unreadCount > 0
              ? `${unreadCount} unread`
              : 'Everything here is read.'}
          </p>
        </div>

        {/*
          * The same pair the bell carries, shown on the same terms: each is
          * rendered only when it would do something. "Clear read" deletes, so
          * it stays second and stays phrased as "read".
          */}
        <div className="notifs__actions">
          {unreadCount > 0 ? (
            <Button variant="ghost" onClick={onMarkAllRead}>
              Mark all read
            </Button>
          ) : null}
          {hasRead ? (
            <Button
              variant="ghost"
              onClick={onClearRead}
              title="Delete the notifications you have already read"
            >
              Clear read
            </Button>
          ) : null}
        </div>
      </header>

      <div className="notifs__filter">
        <SegmentedControl
          items={FILTERS}
          value={filter}
          onChange={setFilter}
          label="Filter notifications"
          size="sm"
        />
      </div>

      {/*
        * Status first, never `loaded.length`. An empty list, a list that has
        * not arrived and a list that failed are three different things, and
        * the audit in Task 17 found six places that had written them as one.
        */}
      {status === 'loading' ? (
        <div className="notifs__list" aria-busy="true">
          {[0, 1, 2, 3, 4].map((row) => (
            <Skeleton key={row} height="4rem" radius="var(--radius-md)" />
          ))}
        </div>
      ) : status === 'error' ? (
        <ErrorState
          title="We couldn't load your notifications"
          message={error}
          onRetry={reload}
        />
      ) : loaded.length === 0 ? (
        <EmptyState
          icon="bell"
          title={filter === 'unread' ? 'Nothing unread' : 'Nothing yet'}
          description={
            filter === 'unread'
              ? 'You have read everything. New replies and posts will show up here.'
              : 'Replies, club threads and new stories from the people you follow turn up here.'
          }
        />
      ) : (
        <>
          <ul className="notifs__list">
            {loaded.map((notification) => (
              <li key={notification.id}>
                <NotificationRow notification={notification} onOpen={onOpen} />
              </li>
            ))}
          </ul>

          {hasMore ? (
            <div className="notifs__more">
              <Button
                variant="ghost"
                onClick={() =>
                  setQuery((current) => ({ ...current, page: current.page + 1 }))
                }
                startIcon={<Icon name="chevron-down" />}
              >
                Load older
              </Button>
            </div>
          ) : null}
        </>
      )}
    </>
  )
}
