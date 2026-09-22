import { useState } from 'react'
import type { CSSProperties } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAsync } from '../hooks/useAsync'
import { useAuth } from '../lib/auth'
import { useToast } from '../lib/toast'
import { hueFor } from '../lib/cover'
import { daysUntil, formatCount, formatDate } from '../lib/format'
import { ApiError } from '../lib/api-client'
import * as challengesApi from '../data/challenges-api'
import * as storiesApi from '../data/stories-api'
import type { ChallengeDetail } from '../types/challenges'
import { ChallengeHostDialog } from '../components/challenges/ChallengeHostDialog'
import { Avatar } from '../components/ui/Avatar'
import { Button } from '../components/ui/Button'
import { Card, SectionHead, StatTile } from '../components/ui/Card'
import { StatusBadge } from '../components/ui/Chip'
import { Dialog } from '../components/ui/Dialog'
import { Icon } from '../components/ui/Icon'
import { Select } from '../components/ui/Select'
import { Skeleton } from '../components/ui/Skeleton'
import { TextField } from '../components/ui/TextField'
import { EmptyState, ErrorState } from '../components/ui/States'
import './pages.css'

const TONE = { active: 'success', upcoming: 'brand', past: 'neutral' } as const

const STATE_LABEL = { active: 'active', upcoming: 'upcoming', past: 'ended' } as const

function messageFor(cause: unknown): string {
  return cause instanceof ApiError || cause instanceof Error
    ? cause.message
    : 'Something went wrong. Please try again.'
}

/**
 * What the page says about the caller's own entry.
 *
 * A draft gets its own line rather than being treated as submitted: the
 * leaderboard only ranks published stories, so a writer who attached a draft
 * would otherwise watch the board and never find themselves on it.
 */
function entryStatus(data: ChallengeDetail): string | null {
  const entry = data.entry
  if (!entry) return null

  if (!entry.story) {
    return data.state === 'active'
      ? `You have a place in this challenge. Attach a story before ${formatDate(data.endsAt)}.`
      : 'You entered this challenge but never attached a story.'
  }

  if (entry.story.status === 'draft') {
    return `Your entry is “${entry.story.title}”, which is still a draft — publish it to appear on the leaderboard.`
  }

  return `Your entry is “${entry.story.title}”.`
}

export function ChallengeDetailPage() {
  const { slug = '' } = useParams()
  const { showToast } = useToast()
  const { session, initialising } = useAuth()
  const authorId = initialising ? undefined : session?.user.id

  const challenge = useAsync(() => challengesApi.getChallenge(slug), [slug])
  const [editing, setEditing] = useState(false)
  const leaderboard = useAsync(() => challengesApi.getLeaderboard(slug), [slug])
  // The entry picker needs the caller's own stories, drafts included.
  const myStories = useAsync(
    () =>
      authorId
        ? storiesApi
            .listStories({ authorId, sort: 'newest', limit: 48 })
            .then((page) => page.items)
        : Promise.resolve([]),
    [authorId],
  )

  const [submitOpen, setSubmitOpen] = useState(false)
  const [storyId, setStoryId] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (challenge.status === 'loading') {
    return (
      <>
        <Skeleton height="12rem" radius="var(--radius-lg)" />
      </>
    )
  }

  if (challenge.status === 'error' || !challenge.data) {
    return (
      <>
        <ErrorState
          title="We couldn't open that challenge"
          message={challenge.error}
          onRetry={challenge.reload}
        />
      </>
    )
  }

  const data = challenge.data
  const entry = data.entry
  const remaining = daysUntil(data.endsAt)
  const opensIn = daysUntil(data.startsAt)

  /** Opens the dialog on whatever the entry already says, so it is an edit. */
  function openSubmit(): void {
    setStoryId(entry?.story?.id ?? '')
    setNote(entry?.note ?? '')
    setError(null)
    setSubmitOpen(true)
  }

  /**
   * Takes a place. Entering and submitting are two requests because the API
   * separates them: the deadline closes the place, and a writer can hold one
   * before they have anything to attach.
   *
   * Deliberately does *not* open the submit dialog straight afterwards.
   * `reload` puts the page back through its loading branch — the pattern every
   * detail page here follows after a write — which would unmount the dialog a
   * moment after opening it. The hero comes back reading "Submit story".
   */
  async function onEnter(): Promise<void> {
    setSubmitting(true)
    try {
      await challengesApi.enterChallenge(data.id)
      showToast({ message: "You're in. Attach a story when you have one." })
      challenge.reload()
    } catch (cause) {
      showToast({ message: messageFor(cause), tone: 'error' })
    } finally {
      setSubmitting(false)
    }
  }

  async function onSubmitEntry(): Promise<void> {
    if (!entry) return

    if (!storyId) {
      setError('Choose which story you are entering.')
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      await challengesApi.updateEntry(entry.id, { storyId, note: note || null })
      setSubmitOpen(false)
      showToast({ message: 'Your entry is in. Good luck.' })
      challenge.reload()
      leaderboard.reload()
    } catch (cause) {
      setError(messageFor(cause))
    } finally {
      setSubmitting(false)
    }
  }

  async function onWithdraw(): Promise<void> {
    if (!entry) return

    setSubmitting(true)
    try {
      await challengesApi.withdrawEntry(entry.id)
      showToast({ message: 'Your entry has been withdrawn.' })
      challenge.reload()
      leaderboard.reload()
    } catch (cause) {
      showToast({ message: messageFor(cause), tone: 'error' })
    } finally {
      setSubmitting(false)
    }
  }

  const rows = leaderboard.data?.items ?? []

  return (
    <>
      <header
        className="challenge-hero"
        style={{ '--challenge-hue': hueFor(data.slug) } as CSSProperties}
      >
        <div className="challenge-hero__top">
          <StatusBadge tone={TONE[data.state]}>{STATE_LABEL[data.state]}</StatusBadge>
          <span>
            <Icon name="calendar" size="0.9em" />
            {formatDate(data.startsAt)} — {formatDate(data.endsAt)}
          </span>
        </div>

        <h1 className="challenge-hero__title">{data.title}</h1>
        <blockquote className="challenge-hero__prompt">“{data.prompt}”</blockquote>
        {data.description ? (
          <p className="challenge-hero__desc">{data.description}</p>
        ) : null}

        <div className="challenge-hero__actions">
          {data.state === 'active' ? (
            entry ? (
              <>
                <Button
                  variant="primary"
                  size="lg"
                  loading={submitting}
                  onClick={openSubmit}
                  startIcon={<Icon name={entry.story ? 'pencil' : 'send'} />}
                >
                  {entry.story ? 'Change entry' : 'Submit story'}
                </Button>
                <Button size="lg" disabled={submitting} onClick={() => void onWithdraw()}>
                  Withdraw
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                size="lg"
                loading={submitting}
                onClick={() => void onEnter()}
                startIcon={<Icon name="plus" />}
              >
                Enter challenge
              </Button>
            )
          ) : data.state === 'upcoming' ? (
            /*
              No "Remind me": there is no notification system to remind anybody
              with yet. The date is the honest thing to show instead.
            */
            <Button size="lg" disabled startIcon={<Icon name="clock" />}>
              {opensIn <= 0 ? 'Opens today' : `Opens in ${opensIn} days`}
            </Button>
          ) : (
            <Button size="lg" disabled startIcon={<Icon name="lock" />}>
              Entries closed
            </Button>
          )}

          {/*
            Editing is an administrator action, offered beside the entry
            actions rather than in a separate host view: there is one
            challenge on this page and one thing a host does to it. `PATCH
            /api/challenges/:id` checks for itself.
          */}
          {session?.user.isAdmin ? (
            <Button size="lg" onClick={() => setEditing(true)} startIcon={<Icon name="pencil" />}>
              Edit
            </Button>
          ) : null}
        </div>

        {entryStatus(data) ? (
          <p className="challenge-hero__entry" role="status">
            {entryStatus(data)}
          </p>
        ) : null}
      </header>

      {editing ? (
        <ChallengeHostDialog
          challenge={data}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false)
            // The window may have moved, and the state is derived from it, so
            // the page is re-read rather than patched.
            challenge.reload()
          }}
        />
      ) : null}

      <div className="stat-row">
        <StatTile
          label="Participants"
          value={formatCount(data.participantCount)}
          icon="users"
        />
        <StatTile label="Entries" value={formatCount(data.entryCount)} icon="pen" />
        <StatTile
          label="Word target"
          value={data.wordTarget ? formatCount(data.wordTarget) : 'No limit'}
          icon="target"
        />
        <StatTile
          label={data.state === 'past' ? 'Ended' : 'Time left'}
          value={
            data.state === 'past'
              ? formatDate(data.endsAt)
              : remaining <= 0
                ? 'Today'
                : `${remaining} days`
          }
          icon="clock"
        />
      </div>

      <section className="page-section">
        <SectionHead
          title="Leaderboard"
          subtitle="Ranked by the star ratings each entry has earned, added up."
        />

        {leaderboard.status === 'error' ? (
          <ErrorState message={leaderboard.error} onRetry={leaderboard.reload} />
        ) : leaderboard.status === 'loading' ? (
          <Skeleton height="12rem" radius="var(--radius-lg)" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="trophy"
            title="No entries yet"
            description="Entries appear here once writers submit a published story."
          />
        ) : (
          <Card padded={false}>
            <ol className="leaderboard">
              {rows.map((row) => (
                <li key={row.entryId}>
                  <span className={`leaderboard__rank is-rank-${Math.min(row.rank, 4)}`}>
                    {row.rank}
                  </span>
                  <Avatar user={row.user} size="sm" />
                  <span className="leaderboard__body">
                    <Link className="leaderboard__story" to={`/story/${row.story.slug}`}>
                      {row.story.title}
                    </Link>
                    <span className="leaderboard__author">
                      @{row.user.username}
                      {row.ratingCount > 0
                        ? ` · ${formatCount(row.ratingCount)} rating${row.ratingCount === 1 ? '' : 's'}`
                        : ' · not yet rated'}
                    </span>
                  </span>
                  <span
                    className="leaderboard__votes"
                    title={
                      row.ratingAverage === null
                        ? 'No ratings yet'
                        : `${row.ratingAverage.toFixed(1)} average over ${row.ratingCount} ratings`
                    }
                  >
                    <Icon name="star" size="0.9em" />
                    {row.score}
                  </span>
                </li>
              ))}
            </ol>
          </Card>
        )}
      </section>

      <Dialog
        open={submitOpen}
        onClose={() => setSubmitOpen(false)}
        title="Submit your entry"
        description={`For “${data.title}”. You can swap the story until the deadline.`}
        dismissible={!submitting}
        footer={
          <>
            <Button onClick={() => setSubmitOpen(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button variant="primary" loading={submitting} onClick={() => void onSubmitEntry()}>
              Submit entry
            </Button>
          </>
        }
      >
        <div className="stack" style={{ gap: 'var(--space-5)' }}>
          {/*
            A failed story list used to render the picker anyway, with nothing
            in it but "Choose a story…" -- indistinguishable from an account
            that has written nothing, except that the empty state below would
            at least have said so. Submitting from it sends an empty id.
          */}
          {myStories.status === 'error' ? (
            <ErrorState
              title="Your stories didn't load"
              message={myStories.error}
              onRetry={myStories.reload}
            />
          ) : myStories.status === 'loading' ? (
            <Skeleton height="3.5rem" radius="var(--radius-md)" />
          ) : myStories.data?.length === 0 ? (
            <EmptyState
              size="sm"
              icon="pen"
              title="You have no stories yet"
              description="Write one first, then come back and enter it."
            />
          ) : (
            <Select
              label="Which story are you entering?"
              value={storyId}
              onChange={(value) => {
                setStoryId(value)
                setError(null)
              }}
              options={[
                { value: '', label: 'Choose a story…' },
                ...(myStories.data ?? []).map((story) => ({
                  value: story.id,
                  label:
                    story.status === 'draft' ? `${story.title} (draft)` : story.title,
                })),
              ]}
            />
          )}

          {error ? (
            <p className="rate-dialog__error" role="alert">
              {error}
            </p>
          ) : null}

          <TextField
            multiline
            label="Note to the host (optional)"
            placeholder="Anything they should know before reading."
            rows={3}
            value={note}
            maxLength={500}
            counterMax={500}
            disabled={submitting}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
      </Dialog>
    </>
  )
}
