import { useCallback, useEffect, useRef, useState } from 'react'
import { streamAssist, type AssistAction, type AssistPayload } from '../../data/ai-api'
import { ApiError } from '../../lib/api-client'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { TextField } from '../ui/TextField'
import './assist.css'

/**
 * The writing assistant's result, beside the author's own text.
 *
 * Three rules hold this together, and they are the feature rather than the
 * model call:
 *
 * - **The draft is never touched until Accept.** This component receives the
 *   passage and returns a replacement; it cannot write to the chapter, so a
 *   failed request, a rejected suggestion and a closed tab all leave the draft
 *   exactly as it was.
 * - **The original stays on screen** next to the suggestion, so accepting is a
 *   comparison rather than a leap of faith.
 * - **The suggestion is labelled.** An author's own words and a model's are
 *   never shown as the same kind of thing.
 *
 * The streaming state lives here rather than in the editor page: the page owns
 * the document, and this owns one transient suggestion about part of it.
 */

export interface AssistRequest {
  action: AssistAction
  /** The passage as it stood when the action was chosen. */
  original: string
  before: string
  after: string
  storyId: string | null
}

const LABELS: Record<AssistAction, string> = {
  improve: 'Improve',
  rewrite: 'Rewrite',
  grammar: 'Fix grammar',
  tone: 'Change tone',
  shorten: 'Shorten',
  expand: 'Expand',
  alternatives: 'Alternatives',
  continue: 'Continue',
}

export const ASSIST_MENU: ReadonlyArray<{ action: AssistAction; label: string }> =
  (Object.keys(LABELS) as AssistAction[]).map((action) => ({
    action,
    label: LABELS[action],
  }))

interface AssistPanelProps {
  request: AssistRequest
  /** Replaces the passage with `text`. The editor decides how. */
  onAccept: (text: string) => void
  onClose: () => void
}

export function AssistPanel({ request, onAccept, onClose }: AssistPanelProps) {
  const [tone, setTone] = useState('')
  const [suggestion, setSuggestion] = useState('')
  const [status, setStatus] = useState<'asking' | 'streaming' | 'done' | 'error'>(
    // The tone action has nothing to run until it knows which tone, and
    // guessing would spend a call on an answer nobody asked for.
    request.action === 'tone' ? 'asking' : 'streaming',
  )
  const [error, setError] = useState<string | null>(null)

  /** Abandons an in-flight suggestion when a second one is asked for. */
  const pending = useRef<AbortController | null>(null)

  const run = useCallback(
    async (targetTone: string | null) => {
      pending.current?.abort()
      const controller = new AbortController()
      pending.current = controller

      setSuggestion('')
      setError(null)
      setStatus('streaming')

      const payload: AssistPayload = {
        action: request.action,
        text: request.original,
        before: request.before,
        after: request.after,
        tone: targetTone,
        storyId: request.storyId,
      }

      try {
        for await (const event of streamAssist(payload, controller.signal)) {
          if (event.type === 'text') {
            setSuggestion((current) => current + event.text)
          } else if (event.type === 'done') {
            // The deltas were for responsiveness; this is the authority — a
            // fence the model opened in its first delta is only recognisable
            // once its last one has arrived.
            setSuggestion(event.text)
          }
        }
        if (!controller.signal.aborted) setStatus('done')
      } catch (cause) {
        if (controller.signal.aborted) return
        setError(
          cause instanceof ApiError
            ? cause.message
            : 'The assistant could not answer just now.',
        )
        setStatus('error')
      }
    },
    [request],
  )

  useEffect(() => {
    if (request.action !== 'tone') void run(null)
    return () => pending.current?.abort()
  }, [request, run])

  const streaming = status === 'streaming'

  return (
    <section className="assist" aria-label="Writing assistant">
      <header className="assist__head">
        <Icon name="sparkle" className="assist__mark" size="1rem" />
        <h3 className="assist__title">{LABELS[request.action]}</h3>
        <span className="assist__badge">AI suggestion</span>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label="Close the assistant"
          onClick={onClose}
          startIcon={<Icon name="close" size="1rem" />}
        />
      </header>

      {status === 'asking' ? (
        <form
          className="assist__tone"
          onSubmit={(event) => {
            event.preventDefault()
            if (tone.trim().length > 0) void run(tone.trim())
          }}
        >
          <TextField
            label="What tone?"
            value={tone}
            maxLength={60}
            placeholder="Warmer, colder, wry, formal…"
            onChange={(event) => setTone(event.target.value)}
          />
          <Button type="submit" variant="primary" disabled={tone.trim().length === 0}>
            Rewrite
          </Button>
        </form>
      ) : (
        <>
          <div className="assist__columns">
            <div className="assist__column">
              <h4 className="assist__column-head">Your text</h4>
              <p className="assist__text">{request.original}</p>
            </div>
            <div className="assist__column assist__column--suggestion">
              <h4 className="assist__column-head">
                Suggestion
                {streaming ? <span className="assist__pulse" aria-hidden /> : null}
              </h4>
              {error ? (
                <p className="assist__error" role="alert">
                  <Icon name="alert" size="0.95em" />
                  {error}
                </p>
              ) : (
                <p className="assist__text">
                  {suggestion || (streaming ? 'Thinking…' : '')}
                </p>
              )}
            </div>
          </div>

          <div className="assist__actions">
            <Button
              variant="primary"
              size="sm"
              disabled={streaming || suggestion.trim().length === 0}
              onClick={() => onAccept(suggestion.trim())}
              startIcon={<Icon name="check" size="0.9em" />}
            >
              Accept
            </Button>
            <Button size="sm" onClick={onClose}>
              Reject
            </Button>
            <Button
              variant="ghost"
              size="sm"
              loading={streaming}
              onClick={() => void run(request.action === 'tone' ? tone.trim() : null)}
            >
              Regenerate
            </Button>
            <p className="assist__note">
              Nothing changes in your chapter until you accept.
            </p>
          </div>
        </>
      )}
    </section>
  )
}
