import { useEffect, useState } from 'react'
import { getStorySummary, regenerateStorySummary } from '../../data/ai-api'
import { ApiError } from '../../lib/api-client'
import { useAsync } from '../../hooks/useAsync'
import { Button } from '../ui/Button'
import { Card, SectionHead } from '../ui/Card'
import { Icon } from '../ui/Icon'
import { Skeleton } from '../ui/Skeleton'
import './story-summary.css'

/**
 * "The story so far" on the story page (Task AI 6).
 *
 * As far as this reader has read, and no further: the server bounds it by
 * their reading position (the opening chapter if they have none) and the
 * whole story for its author, and the summary is reduced from chapter
 * summaries that stop at that bound -- there is no ending in it to spoil.
 *
 * The first reader at a bound waits a few seconds while a background job
 * writes it; everyone after gets it at once. The page polls while the server
 * says `generating`, up to a limit, and keeps the waiting line on screen
 * between polls rather than flashing a skeleton. Labelled as AI-generated
 * wherever it shows.
 */

/** A poll every four seconds for a minute: a summary is a few model calls. */
const POLL_MS = 4000
const MAX_POLLS = 15

export function StorySummaryCard({
  storyKey,
  storyId,
  isAuthor,
}: {
  storyKey: string
  storyId: string
  isAuthor: boolean
}) {
  const status = useAsync(() => getStorySummary(storyKey), [storyKey])
  const [polls, setPolls] = useState(0)
  const [regenerating, setRegenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const waiting = status.data?.generating === true || regenerating

  // Ask again while the server is writing it. The state change happens in the
  // timer's callback, not the effect body.
  const reload = status.reload
  useEffect(() => {
    if (status.status !== 'ready' || !waiting || polls >= MAX_POLLS) return
    const timer = setTimeout(() => {
      setPolls((count) => count + 1)
      reload()
    }, POLL_MS)
    return () => clearTimeout(timer)
  }, [status.status, waiting, polls, reload])

  const summary = status.data?.summary ?? null
  // A regenerate is done when the summary comes back.
  useEffect(() => {
    if (!regenerating || !summary) return
    const done = setTimeout(() => setRegenerating(false), 0)
    return () => clearTimeout(done)
  }, [regenerating, summary])

  if (status.status === 'ready' && status.data && !status.data.available) return null
  if (status.status === 'error') return null // Optional extra: absent, not broken.

  async function regenerate() {
    setError(null)
    try {
      await regenerateStorySummary(storyId)
      setRegenerating(true)
      setPolls(0)
      reload()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'The summary could not be regenerated just now.')
    }
  }

  const bound = summary?.upToChapter ?? status.data?.scope.upToChapter ?? null
  const subtitle =
    status.data?.scope.basis === 'author'
      ? 'Your whole published story, as a reader would be told it.'
      : bound
        ? `Up to chapter ${bound}, where you’ve read to — nothing past it.`
        : 'Up to where you’ve read — nothing past it.'

  return (
    <section className="page-section" aria-label="The story so far">
      <SectionHead
        title="The story so far"
        subtitle={subtitle}
        action={
          isAuthor ? (
            <Button
              size="sm"
              variant="ghost"
              loading={regenerating}
              disabled={regenerating}
              startIcon={<Icon name="retry" size="0.9em" />}
              onClick={() => void regenerate()}
            >
              Regenerate
            </Button>
          ) : undefined
        }
      />
      <Card className="story-summary">
        {summary && !regenerating ? (
          <>
            <p className="story-summary__text">{summary.text}</p>
            <p className="story-summary__note">
              <Icon name="sparkle" size="0.85em" />
              AI-generated from the chapters themselves — it may miss or misread something.
            </p>
          </>
        ) : status.status === 'loading' && polls === 0 ? (
          <Skeleton height="4.5rem" radius="var(--radius-md)" />
        ) : waiting && polls < MAX_POLLS ? (
          <p className="story-summary__pending" role="status">
            Writing the summary from the chapters. This takes a moment.
          </p>
        ) : (
          <p className="story-summary__pending">No summary yet. Check back soon.</p>
        )}
        {error ? <p className="story-summary__error">{error}</p> : null}
      </Card>
    </section>
  )
}
