import type { MouseEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useNotifications } from '../../hooks/useNotifications'
import { NotificationRow } from '../notifications/NotificationRow'
import { Button } from '../ui/Button'
import { DropdownMenu } from '../ui/DropdownMenu'
import { Icon } from '../ui/Icon'
import { Tooltip } from '../ui/Tooltip'
import type { Notification } from '../../types/notifications'

/**
 * The bell, its unread badge and the newest few behind it.
 *
 * Its own component rather than more of `TopBar`, which is already a search
 * field, a theme toggle and an account menu. What a row *looks* like is
 * `components/notifications/NotificationRow.tsx`, shared with
 * `NotificationsPage`; what the bell owns is the badge, the two sweeping
 * actions and the decision to show only the newest handful.
 *
 * Where notifications *come from* is `hooks/useNotifications.ts`, which is
 * also where the seam for replacing the poll with a push sits. Nothing in this
 * file knows there is a poll at all, and that is the point.
 */

/** Past 9 the exact number stops being information and starts being noise. */
function badgeLabel(count: number): string {
  return count > 9 ? '9+' : String(count)
}

/**
 * No props: who is signed in, and therefore whether there is anything to show,
 * is `NotificationsProvider`'s question rather than `TopBar`'s. The bell
 * renders either way -- inert and empty for a signed-out visitor.
 */
export function NotificationBell() {
  const navigate = useNavigate()
  const {
    items,
    unreadCount,
    loading,
    error,
    refresh,
    markRead,
    markAllRead,
    clearRead,
    hasRead,
  } = useNotifications()

  function onOpen(notification: Notification): void {
    if (notification.readAt === null) markRead(notification.id)
    navigate(notification.href)
  }

  const label =
    unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'

  return (
    <DropdownMenu
      label="Notifications"
      trigger={(props) => (
        <Tooltip placement="bottom" label="Notifications">
          <Button
            {...props}
            type="button"
            variant="ghost"
            iconOnly
            aria-label={label}
            className="topbar__bell"
            /**
             * The count rides inside `startIcon` because `iconOnly` drops a
             * `Button`'s children -- that is what makes it icon-only. The
             * alternative is a bare `<button>` carrying the `btn` classes by
             * hand, which is a copy of `Button` that stops matching it.
             *
             * `aria-hidden` on the number: `aria-label` above already says
             * "3 unread", and a screen reader should not hear "3" twice.
             */
            startIcon={
              <span className="topbar__bell-icon">
                <Icon name="bell" size="1.15rem" />
                {unreadCount > 0 ? (
                  <span className="topbar__bell-count" aria-hidden="true">
                    {badgeLabel(unreadCount)}
                  </span>
                ) : null}
              </span>
            }
            /**
             * Re-read on every open, so acting on the bell always shows
             * current data however long the tab has been idle. Fires on close
             * too, which costs one request and saves a branch.
             */
            onClick={(event: MouseEvent<HTMLElement>) => {
              props.onClick(event)
              refresh()
            }}
          />
        </Tooltip>
      )}
    >
      <div className="notifications">
        <div className="notifications__head">
          <p className="notifications__title">Notifications</p>

          {/*
            * Two actions, each shown only when it would do something: "mark
            * all read" with nothing unread is a no-op, and "clear read" with
            * nothing read is a button that empties an empty set. Rendering
            * them disabled instead would mean a permanently greyed pair on a
            * quiet account, which reads as broken rather than as idle.
            *
            * The clearing one is second and phrased as "read" rather than
            * "all" on purpose: it deletes, and the only thing standing between
            * a misclick and a lost reply is that the row had to be read first.
            */}
          <span className="notifications__actions">
            {unreadCount > 0 ? (
              <button
                type="button"
                className="notifications__clear"
                onClick={markAllRead}
              >
                Mark all read
              </button>
            ) : null}
            {hasRead ? (
              <button
                type="button"
                className="notifications__clear"
                onClick={clearRead}
                title="Delete the notifications you have already read"
              >
                Clear read
              </button>
            ) : null}
          </span>
        </div>

        {loading ? (
          <p className="notifications__note">Loading…</p>
        ) : error ? (
          // Only somebody who opened the dropdown sees this. A failed poll
          // leaves the bell alone; see the hook.
          <p className="notifications__note">{error}</p>
        ) : items.length === 0 ? (
          <p className="notifications__note">
            Nothing yet. Replies, club threads and new stories from the people
            you follow turn up here.
          </p>
        ) : (
          <ul className="notifications__list">
            {items.map((notification) => (
              <li key={notification.id}>
                <NotificationRow notification={notification} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        )}

        {/*
          * The way out of the dropdown, and the only one there is: the bell
          * holds the newest twelve, so without this a reader who left it a
          * week has no route to the rest. Shown even when the list is empty or
          * failed -- "there is a page" is true regardless, and a reader whose
          * poll just failed is exactly who wants to go and look properly.
          */}
        <div className="notifications__foot">
          <Link to="/notifications" className="notifications__all">
            See all notifications
          </Link>
        </div>
      </div>
    </DropdownMenu>
  )
}
