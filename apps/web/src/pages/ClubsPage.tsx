import { useState } from 'react'
import { useAsync } from '../hooks/useAsync'
import { useToast } from '../lib/toast'
import { formatCount, formatRelative } from '../lib/format'
import * as api from '../data/api'
import { AppShell } from '../components/layout/AppShell'
import { Avatar } from '../components/ui/Avatar'
import { Button } from '../components/ui/Button'
import { Card, SectionHead } from '../components/ui/Card'
import { Icon } from '../components/ui/Icon'
import { Skeleton } from '../components/ui/Skeleton'
import { Tabs, TabPanel } from '../components/ui/Tabs'
import { EmptyState, ErrorState } from '../components/ui/States'
import { ClubCard } from '../components/story/Cards'
import { Link } from 'react-router-dom'
import './pages.css'

type ClubTab = 'discover' | 'mine' | 'popular'

const TABS = [
  { id: 'discover' as const, label: 'Discover' },
  { id: 'mine' as const, label: 'My clubs' },
  { id: 'popular' as const, label: 'Popular' },
]

export function ClubsPage() {
  const clubs = useAsync(() => api.getClubs(), [])
  const discussions = useAsync(() => api.getClubDiscussions('bc-northernlights'), [])
  const { showToast } = useToast()

  const [tab, setTab] = useState<ClubTab>('discover')
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [joined, setJoined] = useState<Set<string>>(new Set())

  async function onToggleMembership(club: api.ClubWithMeta) {
    if (pendingId) return
    setPendingId(club.id)
    try {
      await new Promise((resolve) => setTimeout(resolve, 450))
      setJoined((current) => {
        const next = new Set(current)
        if (next.has(club.id)) next.delete(club.id)
        else next.add(club.id)
        return next
      })
      showToast({ message: `You joined ${club.name}.` })
    } catch {
      showToast({ tone: 'error', message: `We couldn't join ${club.name}. Please try again.` })
    } finally {
      setPendingId(null)
    }
  }

  const withLocalState = (list: api.ClubWithMeta[]) =>
    list.map((club) =>
      joined.has(club.id) && club.membership === null
        ? { ...club, membership: { role: 'member' } }
        : club,
    )

  const all = withLocalState(clubs.data ?? [])
  const mine = all.filter((club) => club.membership !== null)
  const popular = [...all].sort((a, b) => b.memberCount - a.memberCount)
  const shown = tab === 'mine' ? mine : tab === 'popular' ? popular : all

  return (
    <AppShell>
      <header className="page-head">
        <div>
          <h1 className="page-head__title">Book clubs</h1>
          <p className="page-head__sub">
            Read the same story at the same time as a few thousand other people,
            and argue about it in the threads.
          </p>
        </div>
        <Button variant="primary" startIcon={<Icon name="plus" size="1em" />}>
          Start a club
        </Button>
      </header>

      <div className="page-tabs">
        <Tabs
          items={TABS.map((item) =>
            item.id === 'mine' ? { ...item, count: mine.length } : item,
          )}
          active={tab}
          onChange={setTab}
          label="Club views"
        />
      </div>

      <TabPanel id={tab}>
        {clubs.status === 'error' ? (
          <ErrorState message={clubs.error} onRetry={clubs.reload} />
        ) : clubs.status === 'loading' ? (
          <div className="card-grid card-grid--wide">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} height="16rem" radius="var(--radius-lg)" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <EmptyState
            icon="users"
            title="You haven't joined a club yet"
            description="Clubs read one story at a time — join one and the current book shows up in your library."
            action={<Button variant="primary" onClick={() => setTab('discover')}>Browse clubs</Button>}
          />
        ) : (
          <div className="card-grid card-grid--wide">
            {shown.map((club) => (
              <ClubCard
                key={club.id}
                club={club}
                pending={pendingId === club.id}
                onToggleMembership={onToggleMembership}
              />
            ))}
          </div>
        )}
      </TabPanel>

      {/* Active discussions --------------------------------------------- */}
      <section className="page-section">
        <SectionHead
          title="Active discussions"
          subtitle="The threads people are replying to right now."
        />
        {discussions.status === 'loading' ? (
          <Skeleton height="10rem" radius="var(--radius-lg)" />
        ) : (
          <Card padded={false}>
            <ul className="thread-list">
              {discussions.data?.slice(0, 4).map((thread) => (
                <li key={thread.id}>
                  <Link className="thread" to="/clubs/northern-lights-readers">
                    <Avatar user={thread.user} size="sm" />
                    <span className="thread__body">
                      <span className="thread__title">{thread.title}</span>
                      <span className="thread__meta">
                        {thread.user.displayName} · {formatRelative(thread.createdAt)}
                        {thread.chapterNumber ? ` · chapter ${thread.chapterNumber}` : ''}
                      </span>
                    </span>
                    <span className="thread__replies">
                      <Icon name="comment" size="0.9em" />
                      {formatCount(thread.replyCount)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>
    </AppShell>
  )
}
