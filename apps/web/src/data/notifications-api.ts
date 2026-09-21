/**
 * Notification data access.
 *
 * Every function here talks to the real Scribe API through the shared fetch
 * wrapper, so errors arrive as `ApiError` with a message safe to show. Shares
 * `stories-api.ts`'s dev-identity header for the reason that module gives.
 *
 * Both writes answer with the account's fresh unread count rather than the row
 * they changed, because the bell is the only thing that redraws afterwards --
 * see the routes. That is why `markRead` returns a number and not a
 * `Notification`.
 */

import { request } from '../lib/api-client'
import { readerHeaders } from './stories-api'
import type { NotificationPage } from '../types/notifications'

export interface NotificationQuery {
  page?: number
  limit?: number
  /** Narrows the list to unread. The count comes back whole either way. */
  unread?: boolean
}

export async function getNotifications(
  query: NotificationQuery = {},
): Promise<NotificationPage> {
  return request<NotificationPage>('/notifications', {
    headers: readerHeaders(),
    query: {
      page: query.page === undefined ? undefined : String(query.page),
      limit: query.limit === undefined ? undefined : String(query.limit),
      // Only ever sent as "true": the API reads any other value as false, and
      // an absent parameter says the same thing more plainly.
      unread: query.unread ? 'true' : undefined,
    },
  })
}

/** Marks one read, and answers with the account's new unread count. */
export async function markNotificationRead(id: string): Promise<number> {
  const { unreadCount } = await request<{ unreadCount: number }>(
    `/notifications/${encodeURIComponent(id)}/read`,
    { method: 'POST', headers: readerHeaders() },
  )

  return unreadCount
}

/** Marks the lot read. Answers 0, barring one arriving mid-sweep. */
export async function markAllNotificationsRead(): Promise<number> {
  const { unreadCount } = await request<{ unreadCount: number }>(
    '/notifications/read-all',
    { method: 'POST', headers: readerHeaders() },
  )

  return unreadCount
}

/**
 * Deletes every notification this reader has already read.
 *
 * Read ones only, deliberately -- see `clearRead` in the API service. The
 * answer is the unread count, which this cannot have changed; it comes back so
 * the bell can settle on the server's number rather than the browser's.
 */
export async function clearReadNotifications(): Promise<number> {
  const { unreadCount } = await request<{ unreadCount: number }>(
    '/notifications/read',
    { method: 'DELETE', headers: readerHeaders() },
  )

  return unreadCount
}
