import { useCallback, useEffect, useRef, useState } from 'react'
import {
  generateRecap,
  getRecap,
  type ChapterRecap,
} from '../../data/ai-api'
import { ApiError } from '../../lib/api-client'
import { Icon } from '../ui/Icon'
import './reader-ai.css'

/**
 * "Previously in this story", above chapter two and later.
 *
 * Scribe publishes serially, so the gap between chapters is measured in days
 * or weeks. The reader this is for is the one returning after a fortnight who
 * has lost the thread — not the one working straight through, which is why
 * generation sits behind a button rather than happening on open. Three
 * consequences follow from that, and they are the component:
 *
 * - **The cheap read happens on mount; the expensive one never does.**
 *   `getRecap` cannot reach a model, so asking on every chapter open costs a
 *   single indexed lookup. `generateRecap` can take half a minute of CPU, and
 *   only a click starts it.
 * - **A reader who does not need it pays nothing** — no tokens, no wait, and
 *   no wall of text between them and the chapter they came to read.
 * - **It is labelled.** A machine's paraphrase of somebody's fiction is never
 *   presented as the author's own summary.
 *
 * Renders nothing at all when there is no previous chapter this reader can
 * open — the first chapter of a story, or the first one visible to them.
 */

interface RecapCardProps {
  /** Slug or id; the API accepts either, as the story routes do. */
  storyKey: string
  /** The chapter being read. The recap describes the one before it. */
  chapterNumber: number
}

export function RecapCard({ storyKey, chapterNumber }: RecapCardProps) {
  const [available, setAvailable] = useState(false)
  const [recap, setRecap] = useState<ChapterRecap | null>(null)
  const [open, setOpen] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pending = useRef<AbortController | null>(null)

  /**
   * The stored recap, if there is one. Runs on every chapter change.
   *
   * A failure here is swallowed deliberately: this is an optional extra above
   * a chapter that loads perfectly well without it, and an error banner for a
   * feature the reader did not ask for is worse than its silent absence. The
   * generate path below does report its failures, because there the reader
   * pressed a button and is owed an answer.
   */
  useEffect(() => {
    const controller = new AbortController()

    setOpen(false)
    setError(null)
    setRecap(null)
    setAvailable(false)

    void getRecap(storyKey, chapterNumber, controller.signal)
      .then((status) => {
        if (controller.signal.aborted) return
        setAvailable(status.available)
        setRecap(status.recap)
      })
      .catch(() => {
        /* See above: absent rather than broken. */
      })

    return () => controller.abort()
  }, [storyKey, chapterNumber])

  const generate = useCallback(async () => {
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller

    setGenerating(true)
    setError(null)

    try {
      const status = await generateRecap(
        storyKey,
        chapterNumber,
        controller.signal,
      )
      if (controller.signal.aborted) return
      setRecap(status.recap)
      setOpen(true)
    } catch (cause) {
      if (controller.signal.aborted) return
      setError(
        cause instanceof ApiError
          ? cause.message
          : 'The recap could not be written just now.',
      )
    } finally {
      if (!controller.signal.aborted) setGenerating(false)
    }
  }, [storyKey, chapterNumber])

  useEffect(() => () => pending.current?.abort(), [])

  if (!available) return null

  return (
    <aside className="recap" aria-label="Recap of the previous chapter">
      <div className="recap__head">
        <Icon name="sparkle" className="recap__mark" size="0.9rem" />
        <h2 className="recap__label">Previously</h2>

        {/*
          The chapter's own title and not its number: authors number their
          titles themselves and often disagree with the sequence, so showing
          both reads as a bug even when both are right.
        */}
        {recap ? (
          <span className="recap__chapter">{recap.chapterTitle}</span>
        ) : (
          <span className="recap__chapter">the chapter before this one</span>
        )}

        {recap ? (
          <button
            type="button"
            className="recap__toggle"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            {open ? 'Hide' : 'Show'}
          </button>
        ) : (
          <button
            type="button"
            className="recap__toggle"
            disabled={generating}
            onClick={() => void generate()}
          >
            {generating ? 'Catching you up…' : 'Catch me up'}
          </button>
        )}
      </div>

      {error ? <p className="recap__error">{error}</p> : null}

      {generating && !recap ? (
        <p className="recap__pending">
          Reading the previous chapter. This can take a moment.
        </p>
      ) : null}

      {recap && open ? (
        <>
          <p className="recap__text">{recap.text}</p>
          {/*
            Said plainly rather than implied by an icon. This is a model's
            paraphrase of the author's chapter, and a reader deciding whether
            to trust it should not have to work that out.
          */}
          <p className="recap__note">
            AI-generated summary — it may miss or misread something. The chapter
            itself is the real thing.
          </p>
        </>
      ) : null}
    </aside>
  )
}
