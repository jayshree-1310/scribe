/**
 * Notification types.
 *
 * These mirror the API responses in `apps/api/src/services/notifications.ts`
 * exactly, the same way `types/gamification.ts` mirrors the badges service.
 *
 * A notification carries no ids for the thing it is about -- no `storyId`, no
 * `clubId`. `href` is the answer to the only question the UI asks, decided
 * server-side at fan-out time, so nothing here has to know that a club lives
 * at `/clubs/:slug` and a badge at `/badges`.
 */

/** What happened. The five the API can produce; see `NotificationType`. */
export type NotificationType =
  | 'CHANNEL_POST'
  | 'COMMENT_REPLY'
  | 'CLUB_DISCUSSION'
  | 'NEW_STORY'
  | 'BADGE_EARNED'

/** The same four fields every other author summary carries, and no more. */
export interface NotificationActor {
  id: string
  username: string
  displayName: string | null
  avatarUrl: string | null
}

export interface Notification {
  id: string
  type: NotificationType
  /** The channel, club, story or badge this is about. */
  title: string
  /** A line of the thing itself, or null where there is no body to quote. */
  excerpt: string | null
  /** Where clicking it goes, as a web-app path. */
  href: string
  /** Null until read. */
  readAt: string | null
  createdAt: string
  /** Null for `BADGE_EARNED`; nobody else caused it. */
  actor: NotificationActor | null
}

export interface NotificationPage {
  items: Notification[]
  page: number
  limit: number
  total: number
  totalPages: number
  hasMore: boolean
  /**
   * The whole account's unread count, never the page's and never the filter's
   * -- so the bell shows the same number whichever list is on screen.
   */
  unreadCount: number
}
