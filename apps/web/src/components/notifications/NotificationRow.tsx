import { formatRelative } from '../../lib/format'
import { Avatar } from '../ui/Avatar'
import { Icon } from '../ui/Icon'
import type { IconName } from '../ui/Icon'
import type { Notification, NotificationType } from '../../types/notifications'
import './notifications.css'

/**
 * One notification, as a button that opens it.
 *
 * Lifted out of `NotificationBell` when `NotificationsPage` arrived: the two
 * draw the same row, and the wording below is the kind of thing that goes
 * quietly out of step when it is written twice. The bell decides how many rows
 * to show and the page decides how to page through them; neither knows what a
 * row looks like.
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

interface NotificationRowProps {
  notification: Notification
  /** Marking it read is the caller's job; the row only reports the click. */
  onOpen: (notification: Notification) => void
}

export function NotificationRow({ notification, onOpen }: NotificationRowProps) {
  return (
    <button
      type="button"
      className={
        notification.readAt === null ? 'notification is-unread' : 'notification'
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
        <span className="notification__line">{describe(notification)}</span>
        {notification.excerpt ? (
          <span className="notification__excerpt">{notification.excerpt}</span>
        ) : null}
        <span className="notification__when">
          {formatRelative(notification.createdAt)}
        </span>
      </span>

      {notification.readAt === null ? (
        <span className="notification__dot" aria-hidden="true" />
      ) : null}
    </button>
  )
}
