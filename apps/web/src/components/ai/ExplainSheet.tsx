import { useCallback, useEffect, useRef, useState } from 'react'
import { streamExplain, type ExplainMode } from '../../data/ai-api'
import { ApiError } from '../../lib/api-client'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import type { ChapterSelection } from '../../lib/chapter-selection'
import './reader-ai.css'

/**
 * "What does this mean?" — the reader's counterpart to the writing assistant.
 *
 * A sheet docked to the bottom of the viewport rather than a popover beside
 * the selection, which is the shape every e-reader converged on for lookup and
 * for the same reason: a panel that floats next to a highlight covers the
 * sentence the reader is asking about, and it has to be small to avoid
 * covering more, which leaves a long answer wrapping seven words to a line. A
 * sheet is out of the way by construction and has the full reading width to
 * answer in.
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
  /**
   * Where the selection ends, in page coordinates, so the sheet can scroll it
   * clear of itself. The sheet does not otherwise position against it.
   */
  selectionBottom: number
  onClose: () => void
}

export function ExplainSheet({
  chapterId,
  selection,
  selectionBottom,
  onClose,
}: ExplainSheetProps) {
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
  const sheetRef = useRef<HTMLElement | null>(null)
  /** The one scroll region; reset to the top when a new mode is asked for. */
  const bodyRef = useRef<HTMLDivElement | null>(null)

  const run = useCallback(
    async (chosen: ExplainMode) => {
      pending.current?.abort()
      const controller = new AbortController()
      pending.current = controller

      setMode(chosen)
      setAnswer('')
      setError(null)
      setStatus('streaming')
      if (bodyRef.current) bodyRef.current.scrollTop = 0

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

  /**
   * Runs the default ask once, on open.
   *
   * Safe as a mount-only effect because the sheet is mounted fresh per
   * selection: highlighting something else closes it (see `onSelect` in
   * `ReaderPage`), so there is no case where the selection changes underneath
   * a mounted sheet.
   */
  useEffect(() => {
    void run('explain')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Abandons an in-flight explanation when the sheet closes, so the server
  // stops generating for a reader who has gone.
  useEffect(() => () => pending.current?.abort(), [])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /**
   * Scrolls the highlight clear of the sheet, if the sheet would cover it.
   *
   * The reason for choosing a sheet over a popover was that it does not cover
   * the passage — which is true everywhere except the bottom of the viewport,
   * where it would. A highlight in the last few lines is exactly the case a
   * reader hits at the end of a chapter, so it is worth the dozen lines.
   */
  useEffect(() => {
    const sheet = sheetRef.current
    if (!sheet) return

    const sheetTop = window.scrollY + window.innerHeight - sheet.offsetHeight
    const margin = 24
    if (selectionBottom > sheetTop - margin) {
      window.scrollTo({
        top: window.scrollY + (selectionBottom - sheetTop) + margin * 2,
        behavior: 'smooth',
      })
    }
  }, [selectionBottom])

  return (
    <aside
      ref={sheetRef}
      className="explain-sheet"
      role="dialog"
      aria-label="Explain this passage"
    >
      <div className="explain-sheet__inner">
        <div className="explain-sheet__head">
          <Icon name="sparkle" className="explain-sheet__mark" size="0.95rem" />

          <div
            className="explain-sheet__tabs"
            role="group"
            aria-label="What to ask"
          >
            {MODES.map((option) => (
              <button
                key={option.mode}
                type="button"
                className={`explain-sheet__tab${
                  mode === option.mode ? ' is-on' : ''
                }`}
                title={option.hint}
                disabled={status === 'streaming'}
                onClick={() => void run(option.mode)}
              >
                {option.label}
              </button>
            ))}
          </div>

          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Close"
            onClick={onClose}
            startIcon={<Icon name="close" size="1rem" />}
          />
        </div>

        <div className="explain-sheet__body" ref={bodyRef}>
          {/*
            Clamped to two lines rather than scrollable: this is here so the
            reader can see what is being answered, and the full text is on the
            page behind the sheet.
          */}
          <blockquote className="explain-sheet__passage">
            {selection.text}
          </blockquote>

          {status === 'streaming' && answer.length === 0 ? (
            <p className="explain-sheet__hint">Thinking…</p>
          ) : null}

          {error ? <p className="explain-sheet__error">{error}</p> : null}

          {answer.length > 0 ? (
            <p className="explain-sheet__answer">{answer}</p>
          ) : null}
        </div>

        {status === 'done' ? (
          <p className="explain-sheet__note">
            AI-generated. It has read only this passage and the text around it,
            not the rest of the story.
          </p>
        ) : null}
      </div>
    </aside>
  )
}
