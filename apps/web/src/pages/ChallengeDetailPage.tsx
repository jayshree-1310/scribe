import { useState } from 'react'
import type { CSSProperties } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAsync } from '../hooks/useAsync'
import { useToast } from '../lib/toast'
import { daysUntil, formatCount, formatDate } from '../lib/format'
import * as api from '../data/api'
import { AppShell } from '../components/layout/AppShell'
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

const TONE = { active: 'success', upcoming: 'brand', completed: 'neutral' } as const

export function ChallengeDetailPage() {
  const { slug = '' } = useParams()
  const { showToast } = useToast()

  const challenge = useAsync(() => api.getChallenge(slug), [slug])
  const challengeId = challenge.data?.id
  const leaderboard = useAsync(
    () => (challengeId ? api.getChallengeLeaderboard(challengeId) : Promise.resolve([])),
    [challengeId],
  )
  const myStories = useAsync(() => api.getMyStories(), [])

  const [submitOpen, setSubmitOpen] = useState(false)
  const [storyId, setStoryId] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)

  if (challenge.status === 'loading') {
    return (
      <AppShell>
        <Skeleton height="12rem" radius="var(--radius-lg)" />
      </AppShell>
    )
  }

  if (challenge.status === 'error' || !challenge.data) {
    return (
      <AppShell>
        <ErrorState
          title="We couldn't open that challenge"
          message={challenge.error}
          onRetry={challenge.reload}
        />
      </AppShell>
    )
  }

  const data = challenge.data
  const remaining = daysUntil(data.endsAt)

  async function onSubmitEntry() {
    if (!storyId) {
      setError('Choose which story you are entering.')
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      await new Promise((resolve) => setTimeout(resolve, 600))
      setSubmitted(true)
      setSubmitOpen(false)
      showToast({ message: 'Your entry is in. Good luck.' })
    } catch {
      setError('We could not submit that entry. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AppShell>
      <header
        className="challenge-hero"
        style={{ '--challenge-hue': data.hue } as CSSProperties}
      >
        <div className="challenge-hero__top">
          <StatusBadge tone={TONE[data.state]}>{data.state}</StatusBadge>
          <span>
            <Icon name="calendar" size="0.9em" />
            {formatDate(data.startsAt)} — {formatDate(data.endsAt)}
          </span>
        </div>

        <h1 className="challenge-hero__title">{data.title}</h1>
        <blockquote className="challenge-hero__prompt">“{data.prompt}”</blockquote>
        <p className="challenge-hero__desc">{data.description}</p>

        <div className="challenge-hero__actions">
          {data.state === 'active' ? (
            <Button
              variant="primary"
              size="lg"
              disabled={submitted}
              onClick={() => setSubmitOpen(true)}
              startIcon={<Icon name={submitted ? 'check' : 'send'} />}
            >
              {submitted ? 'Entry submitted' : 'Submit Story'}
            </Button>
          ) : data.state === 'upcoming' ? (
            <Button variant="primary" size="lg" startIcon={<Icon name="bell" />}>
              Remind me when it opens
            </Button>
          ) : (
            <Button size="lg" disabled startIcon={<Icon name="lock" />}>
              Entries closed
            </Button>
          )}
          <Button size="lg" iconOnly aria-label="Share challenge" startIcon={<Icon name="share" />} />
        </div>
      </header>

      <div className="stat-row">
        <StatTile label="Participants" value={formatCount(data.participantCount)} icon="users" />
        <StatTile label="Entries" value={formatCount(data.entryCount)} icon="pen" />
        <StatTile
          label="Word target"
          value={data.wordTarget ? formatCount(data.wordTarget) : 'No limit'}
          icon="target"
        />
        <StatTile
          label={data.state === 'completed' ? 'Ended' : 'Time left'}
          value={
            data.state === 'completed'
              ? formatDate(data.endsAt)
              : remaining <= 0
                ? 'Today'
                : `${remaining} days`
          }
          icon="clock"
        />
      </div>

      <section className="page-section">
        <SectionHead title="Leaderboard" subtitle="Ranked by community votes." />

        {leaderboard.status === 'error' ? (
          <ErrorState message={leaderboard.error} onRetry={leaderboard.reload} />
        ) : leaderboard.data?.length === 0 ? (
          <EmptyState
            icon="trophy"
            title="No entries yet"
            description="Entries appear here as soon as writers start submitting."
          />
        ) : (
          <Card padded={false}>
            <ol className="leaderboard">
              {leaderboard.data?.map((row) => (
                <li key={row.id}>
                  <span className={`leaderboard__rank is-rank-${Math.min(row.rank, 4)}`}>
                    {row.rank}
                  </span>
                  <Avatar user={row.user} size="sm" />
                  <span className="leaderboard__body">
                    <Link className="leaderboard__story" to={`/story/${row.story.slug}`}>
                      {row.story.title}
                    </Link>
                    <span className="leaderboard__author">{row.user.displayName}</span>
                  </span>
                  <span className="leaderboard__votes">
                    <Icon name="heart" size="0.9em" />
                    {formatCount(row.voteCount)}
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
            <Button variant="primary" loading={submitting} onClick={onSubmitEntry}>
              Submit entry
            </Button>
          </>
        }
      >
        <div className="stack" style={{ gap: 'var(--space-5)' }}>
          {myStories.data?.length === 0 ? (
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
                  label: story.title,
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
            label="Note to the judges (optional)"
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
    </AppShell>
  )
}
