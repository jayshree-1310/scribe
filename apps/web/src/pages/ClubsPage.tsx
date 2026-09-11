import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAsync } from '../hooks/useAsync'
import { useToast } from '../lib/toast'
import { formatCount, formatRelative } from '../lib/format'
import * as clubsApi from '../data/clubs-api'
import { clubUserName, type Club } from '../types/clubs'
import { AppShell } from '../components/layout/AppShell'
import { Avatar } from '../components/ui/Avatar'
import { Button } from '../components/ui/Button'
import { Card, SectionHead } from '../components/ui/Card'
import { Dialog } from '../components/ui/Dialog'
import { Icon } from '../components/ui/Icon'
import { Skeleton } from '../components/ui/Skeleton'
import { TextField } from '../components/ui/TextField'
import { Tabs, TabPanel } from '../components/ui/Tabs'
import { EmptyState, ErrorState } from '../components/ui/States'
import { ClubCard } from '../components/story/Cards'
import './pages.css'

type ClubTab = 'discover' | 'mine' | 'popular'

const TABS = [
  { id: 'discover' as const, label: 'Discover' },
  { id: 'mine' as const, label: 'My clubs' },
  { id: 'popular' as const, label: 'Popular' },
]

/**
 * Which API query each tab is. "Discover" and "Popular" differ only in sort --
 * the server has no notion of a club being new to *you* -- and "My clubs" is
 * the membership filter.
 */
const TAB_QUERY: Record<ClubTab, clubsApi.ClubFilters> = {
  discover: { sort: 'newest' },
  mine: { mine: true, sort: 'members' },
  popular: { sort: 'members' },
}

export function ClubsPage() {
  const { showToast } = useToast()

  const [tab, setTab] = useState<ClubTab>('discover')
  const clubs = useAsync(
    () => clubsApi.listClubs({ ...TAB_QUERY[tab], limit: 24 }),
    [tab],
  )

  /**
   * The membership counter on the "My clubs" tab. Loaded separately from the
   * list so the number is there whichever tab is open -- the tab label should
   * not be blank until you click it.
   */
  const mine = useAsync(
    () => clubsApi.listClubs({ mine: true, limit: 1 }),
    [],
  )

  const [pendingId, setPendingId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [errors, setErrors] = useState<{ name?: string }>({})
  const [creating, setCreating] = useState(false)

  /**
   * The five most recent threads across the clubs on screen, so the rail is
   * about clubs the reader can actually open. One request per club, capped --
   * there is no cross-club discussion feed in the API, and inventing one for a
   * sidebar would be the wrong place to start.
   */
  const shown = clubs.data?.items ?? []
  const railKey = shown
    .slice(0, 4)
    .map((club) => club.id)
    .join(',')

  const discussions = useAsync(async () => {
    const clubIds = railKey.length > 0 ? railKey.split(',') : []
    if (clubIds.length === 0) return []

    const pages = await Promise.all(
      clubIds.map(async (clubId) => {
        const page = await clubsApi.getClubDiscussions(clubId, { limit: 3 })
        const club = shown.find((item) => item.id === clubId)
        return page.items.map((thread) => ({ thread, club }))
      }),
    )

    return pages
      .flat()
      .sort(
        (a, b) =>
          new Date(b.thread.createdAt).getTime() -
          new Date(a.thread.createdAt).getTime(),
      )
      .slice(0, 4)
  }, [railKey])

  async function onToggleMembership(club: Club) {
    if (pendingId) return
    setPendingId(club.id)

    const joining = club.membership === null
    try {
      if (joining) await clubsApi.joinClub(club.id)
      else await clubsApi.leaveClub(club.id)

      showToast({
        message: joining ? `You joined ${club.name}.` : `You left ${club.name}.`,
      })
      clubs.reload()
      mine.reload()
    } catch (cause) {
      showToast({
        tone: 'error',
        message:
          cause instanceof Error
            ? cause.message
            : `We couldn't update ${club.name}. Please try again.`,
      })
    } finally {
      setPendingId(null)
    }
  }

  async function onCreate() {
    const trimmed = name.trim()
    if (trimmed.length < 2) {
      setErrors({ name: 'Give the club a name.' })
      return
    }

    setCreating(true)
    try {
      const club = await clubsApi.createClub({
        name: trimmed,
        description: description.trim() || null,
      })

      setCreateOpen(false)
      setName('')
      setDescription('')
      setErrors({})
      showToast({ message: `${club.name} is open. You are its owner.` })
      clubs.reload()
      mine.reload()
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : 'We could not start that club.'
      setErrors({ name: message })
    } finally {
      setCreating(false)
    }
  }

  const emptyCopy: Record<ClubTab, { title: string; description: string }> = {
    discover: {
      title: 'No clubs yet',
      description: 'Start the first one — whoever creates a club owns it.',
    },
    mine: {
      title: "You haven't joined a club yet",
      description:
        'Clubs read one story at a time — join one and its current book shows up here.',
    },
    popular: {
      title: 'No clubs yet',
      description: 'Once clubs have members, the busiest ones show up here.',
    },
  }

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
        <Button
          variant="primary"
          onClick={() => setCreateOpen(true)}
          startIcon={<Icon name="plus" size="1em" />}
        >
          Start a club
        </Button>
      </header>

      <div className="page-tabs">
        <Tabs
          items={TABS.map((item) =>
            item.id === 'mine' ? { ...item, count: mine.data?.total ?? 0 } : item,
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
            title={emptyCopy[tab].title}
            description={emptyCopy[tab].description}
            action={
              tab === 'mine' ? (
                <Button variant="primary" onClick={() => setTab('discover')}>
                  Browse clubs
                </Button>
              ) : (
                <Button variant="primary" onClick={() => setCreateOpen(true)}>
                  Start a club
                </Button>
              )
            }
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
      {shown.length > 0 ? (
        <section className="page-section">
          <SectionHead
            title="Active discussions"
            subtitle="The threads people are replying to right now."
          />
          {discussions.status === 'loading' ? (
            <Skeleton height="10rem" radius="var(--radius-lg)" />
          ) : discussions.status === 'error' ? (
            <ErrorState message={discussions.error} onRetry={discussions.reload} />
          ) : (discussions.data?.length ?? 0) === 0 ? (
            <EmptyState
              size="sm"
              icon="comment"
              title="No discussions yet"
              description="Open a club and start the first thread."
            />
          ) : (
            <Card padded={false}>
              <ul className="thread-list">
                {discussions.data?.map(({ thread, club }) => (
                  <li key={thread.id}>
                    <Link className="thread" to={`/clubs/${club?.slug ?? ''}`}>
                      <Avatar user={thread.user} size="sm" />
                      <span className="thread__body">
                        {/*
                          `ClubDiscussion` has no title column — the mock's was
                          invented — so the body is the headline, clamped by
                          `.thread__title`'s own line clamp.
                        */}
                        <span className="thread__title">{thread.body}</span>
                        <span className="thread__meta">
                          {clubUserName(thread.user)} ·{' '}
                          {formatRelative(thread.createdAt)}
                          {club ? ` · ${club.name}` : ''}
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
      ) : null}

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Start a book club"
        description="You will be its owner. Anyone can join an open club."
        dismissible={!creating}
        footer={
          <>
            <Button onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button variant="primary" loading={creating} onClick={onCreate}>
              Start club
            </Button>
          </>
        }
      >
        <div className="stack" style={{ gap: 'var(--space-5)' }}>
          <TextField
            label="Name"
            placeholder="Northern Lights Readers"
            value={name}
            error={errors.name}
            maxLength={120}
            counterMax={120}
            disabled={creating}
            onChange={(event) => {
              setName(event.target.value)
              setErrors({})
            }}
          />
          <TextField
            multiline
            label="Description"
            placeholder="What does this club read, and how fast?"
            rows={4}
            value={description}
            maxLength={2000}
            counterMax={2000}
            disabled={creating}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
      </Dialog>
    </AppShell>
  )
}
