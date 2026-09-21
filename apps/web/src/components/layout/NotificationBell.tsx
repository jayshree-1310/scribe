import type { MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useNotifications } from '../../hooks/useNotifications'
import { formatRelative } from '../../lib/format'
import { Avatar } from '../ui/Avatar'
import { Button } from '../ui/Button'
import { DropdownMenu } from '../ui/DropdownMenu'
import { Icon } from '../ui/Icon'
import type { IconName } from '../ui/Icon'
import { Tooltip } from '../ui/Tooltip'
import type { Notification, NotificationType } from '../../types/notifications'

/**
 * The bell, its unread badge and the list behind it.
 *
 * Its own component rather than more of `TopBar`, which is already a search
 * field, a theme toggle and an account menu. Nothing else renders a
 * notification, so everything about how one reads lives here.
 *
 * Where notifications *come from* is `hooks/useNotifications.ts`, which is
 * also where the seam for replacing the poll with a push sits. Nothing in this
 * file knows there is a poll at all, and that is the point.
 */

/** A face where there is somebody, and a symbol where there is not. */
const TYPE_ICONS: Record<NotificationType, IconName> = {
  CHANNEL_POST: 'megaphone',
  COMMENT_REPLY: 'comment',
  STORY_COMMENT: 'comment',
  CLUB_DISCUSSION: 'users',
  NEW_STORY: 'book',
  BADGE_EARNED: 'medal',
}

/**
 * The sentence a notification reads as.
 *
 * Composed here rather than stored: the API sends who did it and what it
 * happened to, and the wording is a UI decision that should not need a
 * migration. `title` is the channel, club, story or badge; `excerpt` is the
 * thing itself and is drawn underneath.
 */
function describe(notification: Notification): string {
  const who =
    notification.actor?.displayName ??
    (notification.actor ? `@${notification.actor.username}` : 'Somebody')

  switch (notification.type) {
    case 'CHANNEL_POST':
      return `${who} posted in ${notification.title}`
    case 'COMMENT_REPLY':
      return `${who} replied to you in ${notification.title}`
    case 'STORY_COMMENT':
      // "on" rather than "in": this one is about the reader's own story, and
      // the reply above is about a conversation inside somebody's.
      return `${who} commented on ${notification.title}`
    case 'CLUB_DISCUSSION':
      return `${who} started a thread in ${notification.title}`
    case 'NEW_STORY':
      return `${who} published ${notification.title}`
    case 'BADGE_EARNED':
      // The one with no actor: nobody did this *to* the reader.
      return `You earned ${notification.title}`
  }
}

/** Past 9 the exact number stops being information and starts being noise. */
function badgeLabel(count: number): string {
  return count > 9 ? '9+' : String(count)
}

interface NotificationBellProps {
  /** False when nobody is signed in: the bell renders, inert and empty. */
  enabled: boolean
}

export function NotificationBell({ enabled }: NotificationBellProps) {
  const navigate = useNavigate()
  const { items, unreadCount, loading, error, refresh, markRead, markAllRead } =
    useNotifications(enabled)

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
          {unreadCount > 0 ? (
            <button
              type="button"
              className="notifications__clear"
              onClick={markAllRead}
            >
              Mark all read
            </button>
          ) : null}
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
                <button
                  type="button"
                  className={
                    notification.readAt === null
                      ? 'notification is-unread'
                      : 'notification'
                  }
                  onClick={() => onOpen(notification)}
                >
                  <span className="notification__face">
                    {notification.actor ? (
                      <Avatar user={notification.actor} size="sm" />
                    ) : (
                      <span className="notification__icon">
                        <Icon name={TYPE_ICONS[notification.type]} size="1rem" />
                      </span>
                    )}
                  </span>

                  <span className="notification__body">
                    <span className="notification__line">
                      {describe(notification)}
                    </span>
                    {notification.excerpt ? (
                      <span className="notification__excerpt">
                        {notification.excerpt}
                      </span>
                    ) : null}
                    <span className="notification__when">
                      {formatRelative(notification.createdAt)}
                    </span>
                  </span>

                  {notification.readAt === null ? (
                    <span className="notification__dot" aria-hidden="true" />
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </DropdownMenu>
  )
}
