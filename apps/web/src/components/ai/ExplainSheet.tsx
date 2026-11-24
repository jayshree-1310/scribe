import { useCallback, useEffect, useRef, useState } from 'react'
import { streamExplain, type ExplainMode } from '../../data/ai-api'
import { ApiError } from '../../lib/api-client'
import { ReaderPanel } from '../reader/ReaderPanel'
import type { ChapterSelection } from '../../lib/chapter-selection'
import './reader-ai.css'

/**
 * "What does this mean?" — the reader's counterpart to the writing assistant.
 *
 * In the reader's side panel (`ReaderPanel`) rather than a popover beside the
 * selection: a panel that floats next to a highlight covers the sentence the
 * reader is asking about, and it has to be small to avoid covering more, which
 * leaves a long answer wrapping seven words to a line. The side panel is out
 * of the way by construction, and the chapter slides over to keep the passage
 * beside it.
 *
 * **There is exactly one scroll region**, `.explain-sheet__body`. Nested
 * scrollbars — a capped quote inside a capped answer inside a scrolling page —
 * are what made the first version of this unreadable. The quote clamps with an
 * ellipsis instead, because it is an orientation aid rather than something to
 * read: the reader wrote it, and the real copy is on the page behind.
 *
 * The three modes are a closed set rather than a text box. An unfamiliar word
 * wants a definition, a knotted sentence wants a plainer restatement, and an
 * allusion wants an explanation — three prompts. A free-text box would invite
 * "what happens next", which is the one question this must never answer.
 *
 * **The passage is never sent.** The payload is the chapter id and a pair of
 * offsets; the server reads the text out of the stored chapter itself. See the
 * header of `services/ai/explain.ts`. What is shown as the quote below is the
 * reader's own local selection — no round trip, and exactly what they marked.
 */

const MODES: ReadonlyArray<{ mode: ExplainMode; label: string; hint: string }> = [
  { mode: 'explain', label: 'Explain', hint: 'What this means in context' },
  { mode: 'simplify', label: 'Simpler', hint: 'The same thing in plainer words' },
  { mode: 'define', label: 'Define', hint: 'What this word or phrase means' },
]

interface ExplainSheetProps {
  chapterId: string
  selection: ChapterSelection
  onClose: () => void
}

export function ExplainSheet({ chapterId, selection, onClose }: ExplainSheetProps) {
  /**
   * Opens on `explain` and runs it immediately, rather than waiting for a
   * second click.
   *
   * The reader has already pressed "Ask about this" on a passage they chose —
   * that press is the consent, and making them then pick from three buttons to
   * get the obvious one is a step that buys nothing. The tabs stay, for
   * switching to a plainer restatement or a definition.
   */
  const [mode, setMode] = useState<ExplainMode>('explain')
  const [answer, setAnswer] = useState('')
  const [status, setStatus] = useState<'streaming' | 'done' | 'error'>(
    'streaming',
  )
  const [error, setError] = useState<string | null>(null)

  const pending = useRef<AbortController | null>(null)
  /** The one scroll region; reset to the top when a new mode is asked for. */
  const bodyRef = useRef<HTMLDivElement | null>(null)

  /**
   * Streams one answer into state that is already clear. Split from `run` so
   * the ask on open starts from the initial state rather than resetting it
   * from an effect.
   */
  const stream = useCallback(
    async (chosen: ExplainMode) => {
      pending.current?.abort()
      const controller = new AbortController()
      pending.current = controller

      try {
        for await (const event of streamExplain(
          {
            chapterId,
            start: selection.start,
            end: selection.end,
            mode: chosen,
          },
          controller.signal,
        )) {
          if (event.type === 'text') {
            setAnswer((current) => current + event.text)
          }
        }
        if (!controller.signal.aborted) setStatus('done')
      } catch (cause) {
        if (controller.signal.aborted) return
        setError(
          cause instanceof ApiError
            ? cause.message
            : 'That could not be explained just now.',
        )
        setStatus('error')
      }
    },
    [chapterId, selection.start, selection.end],
  )

  /** Asks in another mode, from a tab: clears the last answer first. */
  const run = useCallback(
    (chosen: ExplainMode) => {
      setMode(chosen)
      setAnswer('')
      setError(null)
      setStatus('streaming')
      if (bodyRef.current) bodyRef.current.scrollTop = 0
      void stream(chosen)
    },
    [stream],
  )

  /**
   * Runs the default ask once, on open.
   *
   * Safe as a mount-only effect because the sheet is mounted fresh per
   * selection: highlighting something else closes it (see `onSelect` in
   * `ReaderPage`), so there is no case where the selection changes underneath
   * a mounted sheet.
   */
  useEffect(() => {
    // Every setState in `stream` comes after its first await; the rule cannot
    // see an await, so it reads them as synchronous.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void stream('explain')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Abandons an in-flight explanation when the sheet closes, so the server
  // stops generating for a reader who has gone.
  useEffect(() => () => pending.current?.abort(), [])

  return (
    <ReaderPanel
      label="Explain this passage"
      icon="sparkle"
      onClose={onClose}
      head={
        <div className="explain-sheet__tabs" role="group" aria-label="What to ask">
          {MODES.map((option) => (
            <button
              key={option.mode}
              type="button"
              className={`explain-sheet__tab${mode === option.mode ? ' is-on' : ''}`}
              title={option.hint}
              disabled={status === 'streaming'}
              onClick={() => run(option.mode)}
            >
              {option.label}
            </button>
          ))}
        </div>
      }
    >
      <div className="explain-sheet__body" ref={bodyRef}>
        {/*
          Clamped to two lines rather than scrollable: this is here so the
          reader can see what is being answered, and the full text is on the
          page beside the panel.
        */}
        <blockquote className="explain-sheet__passage">{selection.text}</blockquote>

        {status === 'streaming' && answer.length === 0 ? (
          <p className="explain-sheet__hint">Thinking…</p>
        ) : null}

        {error ? <p className="explain-sheet__error">{error}</p> : null}

        {answer.length > 0 ? <p className="explain-sheet__answer">{answer}</p> : null}
      </div>

      {status === 'done' ? (
        <p className="explain-sheet__note">
          AI-generated. It has read only this passage and the text around it,
          not the rest of the story.
        </p>
      ) : null}
    </ReaderPanel>
  )
}
