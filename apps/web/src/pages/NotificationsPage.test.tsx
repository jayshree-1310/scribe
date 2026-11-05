/**
 * The notifications page, signed in, against a fake API holding real-shaped
 * rows: the list, "Load older", the filter, the empty and failed states, and
 * the optimistic writes rolling back when the server refuses them.
 *
 * Drawn with the real notification source (`useNotificationsSource`) rather
 * than a stub, because the page delegates every write to it and mirrors the
 * result: the rollback is a conversation between the two.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  NotificationsContext,
  useNotifications,
  useNotificationsSource,
} from '../hooks/useNotifications'
import { setAccessToken } from '../lib/access-token'
import { apiError, fakeApi, type FakeApi } from '../test/fake-api'
import type { Notification } from '../types/notifications'
import { NotificationsPage } from './NotificationsPage'

let api: FakeApi
/** The server's rows, newest first. */
let rows: Notification[]

function notification(n: number, read = false): Notification {
  return {
    id: `n-${n}`,
    type: 'CHANNEL_POST',
    title: `Channel ${n}`,
    excerpt: null,
    href: `/channels/channel-${n}`,
    readAt: read ? '2026-11-01T10:00:00.000Z' : null,
    createdAt: new Date(Date.UTC(2026, 10, 1) - n * 60_000).toISOString(),
    actor: { id: 'u-ada', username: 'ada', displayName: 'Ada', avatarUrl: null },
  }
}

const unread = () => rows.filter((row) => row.readAt === null).length

/** `GET /notifications` as the API answers it: paged, filtered, and the account's whole unread count. */
function serveRows() {
  api.on('GET /notifications', (call) => {
    const page = Number(call.query.get('page') ?? 1)
    const limit = Number(call.query.get('limit') ?? 20)
    const matching =
      call.query.get('unread') === 'true' ? rows.filter((row) => row.readAt === null) : rows
    return {
      items: matching.slice((page - 1) * limit, page * limit),
      page,
      limit,
      total: matching.length,
      totalPages: Math.ceil(matching.length / limit),
      hasMore: page * limit < matching.length,
      unreadCount: unread(),
    }
  })
}

/** What the bell would show, on the page a notification links to. */
function ChannelPage() {
  return <p>Channel page · {useNotifications().unreadCount} unread</p>
}

function Signedin() {
  const source = useNotificationsSource(true)
  return (
    <NotificationsContext.Provider value={source}>
      <MemoryRouter initialEntries={['/notifications']}>
        <Routes>
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/channels/:slug" element={<ChannelPage />} />
        </Routes>
      </MemoryRouter>
    </NotificationsContext.Provider>
  )
}

const listed = () => screen.queryAllByRole('button', { name: /^Ada posted in Channel/ })
const unreadRows = () => listed().filter((row) => row.classList.contains('is-unread'))
const pageCalls = () =>
  api.callsTo('GET /notifications').filter((call) => call.query.get('limit') === '20')

beforeEach(() => {
  api = fakeApi()
  setAccessToken('signed-in')
  rows = []
  serveRows()
})

describe('the list', () => {
  it('shows twenty, and "Load older" adds each next page under them until there are none', async () => {
    rows = Array.from({ length: 45 }, (_, i) => notification(i + 1, i >= 3))
    const user = userEvent.setup()
    render(<Signedin />)

    await waitFor(() => expect(listed()).toHaveLength(20))
    expect(screen.getByText('3 unread')).toBeTruthy()
    expect(listed()[0]?.textContent).toContain('Channel 1')

    await user.click(screen.getByRole('button', { name: 'Load older' }))
    await waitFor(() => expect(listed()).toHaveLength(40))
    await user.click(screen.getByRole('button', { name: 'Load older' }))
    await waitFor(() => expect(listed()).toHaveLength(45))

    expect(screen.queryByRole('button', { name: 'Load older' })).toBeNull()
    expect(listed().map((row) => row.querySelector('.notification__line')?.textContent)).toEqual(
      rows.map((row) => `Ada posted in ${row.title}`),
    )
    expect(pageCalls().map((call) => call.query.get('page'))).toEqual(['1', '2', '3'])
  })

  it('asks for unread only under the filter, and says so when there are none', async () => {
    rows = [notification(1, true), notification(2, true)]
    const user = userEvent.setup()
    render(<Signedin />)
    await waitFor(() => expect(listed()).toHaveLength(2))
    expect(screen.getByText('Everything here is read.')).toBeTruthy()

    await user.click(screen.getByRole('radio', { name: 'Unread' }))

    await screen.findByText('Nothing unread')
    expect(pageCalls().at(-1)?.query.get('unread')).toBe('true')
    expect(listed()).toHaveLength(0)
  })

  it('says when there is nothing at all', async () => {
    render(<Signedin />)
    await screen.findByText('Nothing yet')
  })

  it('says when the list did not load, and loads it on "Try again"', async () => {
    rows = [notification(1)]
    api.on('GET /notifications', () => apiError(503, 'service_unavailable', 'Down for a moment.'))
    const user = userEvent.setup()
    render(<Signedin />)

    await screen.findByText("We couldn't load your notifications")
    expect(screen.getByText('Down for a moment.')).toBeTruthy()

    serveRows()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(listed()).toHaveLength(1))
  })
})

describe('opening one', () => {
  it('goes where it points, and the bell drops by one with the server', async () => {
    rows = [notification(1), notification(2)]
    api.on('POST /notifications/:id/read', (call) => {
      rows = rows.map((row) => (row.id === call.params['id'] ? { ...row, readAt: 'now' } : row))
      return { unreadCount: unread() }
    })
    const user = userEvent.setup()
    render(<Signedin />)
    await waitFor(() => expect(unreadRows()).toHaveLength(2))

    await user.click(listed()[0]!)

    await screen.findByText('Channel page · 1 unread')
    expect(api.callsTo('POST /notifications/:id/read')[0]?.params['id']).toBe('n-1')
  })

  it('puts the count back when the server refuses the read', async () => {
    rows = [notification(1), notification(2)]
    let refuse!: () => void
    api.on(
      'POST /notifications/:id/read',
      () => new Promise((resolve) => (refuse = () => resolve(apiError(500, 'internal_error', 'No.')))),
    )
    const user = userEvent.setup()
    render(<Signedin />)
    await waitFor(() => expect(unreadRows()).toHaveLength(2))

    await user.click(listed()[0]!)
    // Optimistic: the reader is already on the channel, one fewer unread.
    await screen.findByText('Channel page · 1 unread')

    await act(async () => refuse())
    await screen.findByText('Channel page · 2 unread')
  })
})

describe('the sweeps', () => {
  it('marks everything read', async () => {
    rows = [notification(1), notification(2), notification(3, true)]
    api.on('POST /notifications/read-all', () => {
      rows = rows.map((row) => ({ ...row, readAt: row.readAt ?? 'now' }))
      return { unreadCount: 0 }
    })
    const user = userEvent.setup()
    render(<Signedin />)
    await waitFor(() => expect(unreadRows()).toHaveLength(2))

    await user.click(screen.getByRole('button', { name: 'Mark all read' }))

    await screen.findByText('Everything here is read.')
    expect(unreadRows()).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Mark all read' })).toBeNull()
  })

  it('re-reads the list when marking everything read fails, rather than trusting its own copy', async () => {
    rows = [notification(1), notification(2), notification(3, true)]
    let refuse!: () => void
    api.on(
      'POST /notifications/read-all',
      () => new Promise((resolve) => (refuse = () => resolve(apiError(500, 'internal_error', 'No.')))),
    )
    const user = userEvent.setup()
    render(<Signedin />)
    await waitFor(() => expect(unreadRows()).toHaveLength(2))
    const readsBefore = pageCalls().length

    await user.click(screen.getByRole('button', { name: 'Mark all read' }))
    expect(unreadRows()).toHaveLength(0)

    await act(async () => refuse())
    await waitFor(() => expect(unreadRows()).toHaveLength(2))
    expect(pageCalls().length).toBeGreaterThan(readsBefore)
    expect(screen.getByText('2 unread')).toBeTruthy()
  })

  it('clears the read ones and keeps the unread', async () => {
    rows = [notification(1), notification(2, true), notification(3, true)]
    api.on('DELETE /notifications/read', () => {
      rows = rows.filter((row) => row.readAt === null)
      return { unreadCount: unread() }
    })
    const user = userEvent.setup()
    render(<Signedin />)
    await waitFor(() => expect(listed()).toHaveLength(3))

    await user.click(screen.getByRole('button', { name: 'Clear read' }))

    await waitFor(() => expect(listed()).toHaveLength(1))
    expect(within(listed()[0]!).getByText(/Channel 1/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Clear read' })).toBeNull()
  })
})
