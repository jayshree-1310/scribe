import { useEffect, useRef, useState, type FormEvent } from 'react'
import * as aiApi from '../../data/ai-api'
import { ApiError } from '../../lib/api-client'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { Icon } from '../ui/Icon'
import { Spinner } from '../ui/Spinner'
import { TextField } from '../ui/TextField'
import './story-assistant.css'

/**
 * "Ask about this story": the assistant with tools, for the author at work.
 *
 * Ask This Book answers a reader from passages fetched in one fixed step. This
 * one decides what to look up — the chapters, the story bible, the continuity
 * findings — which is why it lives in the editor: two of its tools only answer
 * a story's own author, and the questions an author has mid-draft ("what did
 * I say her eyes were?", "is anything flagged in chapter 4?") are lookups, not
 * a single search.
 *
 * Three rules shape it:
 *
 * - **Every lookup is shown as it happens.** The wait is the lookups between
 *   model calls, so the panel says which one is running, and each answer keeps
 *   the list of what it was drawn from. Nothing about it is a black box.
 * - **It remembers this conversation, and only here.** Earlier exchanges go
 *   back with each question so "and her sister?" resolves; nothing is stored,
 *   so closing the editor forgets it. The server treats them as context, never
 *   as a source, and its tools run as the author whatever they say.
 * - **It is labelled.** An answer is the model's reading of the author's own
 *   material, and says so.
 *
 * The caller keys this on the story, so another story starts a fresh
 * conversation.
 */

interface Exchange {
  question: string
  /** Null until `done` arrives. */
  answer: string | null
  steps: aiApi.AgentStep[]
  /** The lookup running now, between its `lookup` and `step` events. */
  looking: string | null
  error: string | null
}

const LOOKUP_LABELS: Record<string, string> = {
  search_stories: 'Searching stories',
  search_chapters: 'Searching your chapters',
  get_story_summary: 'Reading the story details',
  get_character_facts: 'Checking the story bible',
  check_continuity: 'Checking continuity',
}

const STEP_LABELS: Record<string, string> = {
  search_stories: 'Searched stories',
  search_chapters: 'Searched your chapters',
  get_story_summary: 'Read the story details',
  get_character_facts: 'Checked the story bible',
  check_continuity: 'Checked continuity',
}

/** What the model asked for, in a few words, for the trace. */
function stepDetail(step: aiApi.AgentStep): string | null {
  const args = step.arguments as Record<string, unknown> | null
  if (!args) return null
  for (const key of ['query', 'subject', 'chapterNumber']) {
    const value = args[key]
    if (typeof value === 'string' || typeof value === 'number') {
      return key === 'chapterNumber' ? `chapter ${value}` : `“${value}”`
    }
  }
  return null
}

function stepNote(step: aiApi.AgentStep): string | null {
  if (step.outcome === 'ok') return null
  if (step.outcome === 'refused') return 'not available'
  if (step.outcome === 'skipped') return 'skipped: lookup limit reached'
  return 'failed'
}

/**
 * The memory sent with a question: answered exchanges only, newest kept, each
 * answer clipped to what the server accepts.
 */
function historyOf(exchanges: Exchange[]): aiApi.AgentExchange[] {
  return exchanges
    .filter((exchange): exchange is Exchange & { answer: string } => exchange.answer !== null)
    .slice(-aiApi.AGENT_HISTORY_LIMIT)
    .map((exchange) => ({
      question: exchange.question,
      answer: exchange.answer.slice(0, aiApi.AGENT_HISTORY_ANSWER_LIMIT),
    }))
}

interface StoryAssistantProps {
  storyId: string
}

export function StoryAssistant({ storyId }: StoryAssistantProps) {
  const [exchanges, setExchanges] = useState<Exchange[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const pending = useRef<AbortController | null>(null)
  const listRef = useRef<HTMLOListElement | null>(null)

  // Leaving the editor stops a lookup nobody will read.
  useEffect(() => () => pending.current?.abort(), [])

  /** Changes the newest exchange: the one a stream is writing into. */
  function updateLast(change: (exchange: Exchange) => Exchange) {
    setExchanges((current) =>
      current.length === 0
        ? current
        : [...current.slice(0, -1), change(current[current.length - 1]!)],
    )
  }

  async function ask(event: FormEvent) {
    event.preventDefault()
    const question = draft.trim()
    if (question.length < 2 || busy) return

    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller

    const history = historyOf(exchanges)
    setExchanges((current) => [
      ...current,
      { question, answer: null, steps: [], looking: null, error: null },
    ])
    setDraft('')
    setBusy(true)

    try {
      let answered = false
      for await (const update of aiApi.streamAgent(question, storyId, history, controller.signal)) {
        if (update.type === 'lookup') {
          updateLast((exchange) => ({ ...exchange, looking: update.tool }))
        } else if (update.type === 'step') {
          updateLast((exchange) => ({
            ...exchange,
            looking: null,
            steps: [...exchange.steps, update.step],
          }))
        } else {
          answered = true
          updateLast((exchange) => ({
            ...exchange,
            looking: null,
            answer: update.answer,
            steps: update.steps,
          }))
        }
      }
      if (!answered && !controller.signal.aborted) {
        updateLast((exchange) => ({
          ...exchange,
          looking: null,
          error: 'The answer stopped before it arrived. Try asking again.',
        }))
      }
    } catch (cause) {
      if (controller.signal.aborted) return
      updateLast((exchange) => ({
        ...exchange,
        looking: null,
        error:
          cause instanceof ApiError ? cause.message : 'The assistant could not answer just now.',
      }))
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  function clear() {
    pending.current?.abort()
    setExchanges([])
    setBusy(false)
  }

  // Keeps the newest exchange in view as its lookups and answer arrive.
  const last = exchanges[exchanges.length - 1]
  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: 'nearest' })
  }, [last])

  return (
    <Card className="story-assistant">
      <div className="editor__side-head">
        <h2>Ask about this story</h2>
        {exchanges.length > 0 ? (
          <Button size="sm" variant="ghost" onClick={clear}>
            Clear
          </Button>
        ) : null}
      </div>

      {exchanges.length === 0 ? (
        <p className="story-assistant__intro">
          Ask about your own chapters, characters or continuity — “what colour
          are Mira’s eyes?”, “is anything flagged in chapter 3?”. It looks
          things up rather than guessing, and shows what it checked.
        </p>
      ) : (
        <ol className="story-assistant__list" ref={listRef} aria-live="polite">
          {exchanges.map((exchange, index) => (
            <li key={index} className="story-assistant__exchange">
              <p className="story-assistant__question">{exchange.question}</p>

              {exchange.steps.length > 0 ? (
                <ul className="story-assistant__steps" aria-label="What it looked up">
                  {exchange.steps.map((step, stepIndex) => {
                    const detail = stepDetail(step)
                    const note = stepNote(step)
                    return (
                      <li
                        key={stepIndex}
                        className={step.outcome === 'ok' ? undefined : 'is-unavailable'}
                      >
                        <Icon name={step.outcome === 'ok' ? 'check' : 'info'} size="0.85em" />
                        <span>
                          {STEP_LABELS[step.tool] ?? step.tool}
                          {detail ? ` for ${detail}` : ''}
                          {note ? ` — ${note}` : ''}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              ) : null}

              {exchange.looking ? (
                <p className="story-assistant__looking">
                  <Spinner /> {LOOKUP_LABELS[exchange.looking] ?? 'Looking that up'}…
                </p>
              ) : exchange.answer === null && exchange.error === null ? (
                <p className="story-assistant__looking">
                  <Spinner /> Thinking…
                </p>
              ) : null}

              {exchange.answer !== null ? (
                <div className="story-assistant__answer">
                  <span className="story-assistant__badge">AI answer</span>
                  <p>{exchange.answer}</p>
                </div>
              ) : null}

              {exchange.error ? (
                <p className="story-assistant__error" role="alert">
                  <Icon name="alert" size="0.9em" /> {exchange.error}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      )}

      <form className="story-assistant__form" onSubmit={(event) => void ask(event)}>
        <TextField
          label="Your question"
          hideLabel
          value={draft}
          maxLength={500}
          placeholder={exchanges.length > 0 ? 'Ask a follow-up…' : 'Ask about this story…'}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button
          type="submit"
          size="sm"
          disabled={busy || draft.trim().length < 2}
          startIcon={<Icon name="send" size="0.95em" />}
        >
          Ask
        </Button>
      </form>
    </Card>
  )
}
