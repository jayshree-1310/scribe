import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  deleteConversation,
  getConversation,
  listConversations,
  startConversation,
  streamConversationMessage,
  type AskCitation,
  type AskScope,
  type Conversation,
  type ConversationSummary,
} from '../../data/ai-api'
import { ApiError } from '../../lib/api-client'
import { cn } from '../../lib/cn'
import { formatRelative } from '../../lib/format'
import { segmentAnswer } from '../../lib/ask-citations'
import type { ChapterSummary } from '../../types/stories'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Select } from '../ui/Select'
import { TextField } from '../ui/TextField'
import './ask.css'

/**
 * Ask This Book, as a conversation: questions about the story, answered from
 * its own text, with the passages to check each answer against — and follow-
 * ups that work, because "what happened after that?" is resolved on the
 * server into a question retrieval can use.
 *
 * What the panel owes the reader, turn by turn:
 *
 * - **Citations per answer.** Every `[n]` is a button to the passage it leans
 *   on, every passage a link into the chapter. An answer that cites nothing
 *   says so beneath it.
 * - **What was actually searched for.** A follow-up is rewritten before it is
 *   searched with, and the rewrite is shown under the answer. When an answer
 *   misses, the reader can see whether it misunderstood the question.
 * - **The range, visible and theirs.** Answers come only from chapters up to
 *   a bound — where the reader has read to, by default — and each answer says
 *   which bound it used. Widening it is an explicit choice that may spoil.
 * - **"Not in the story" is a notice, not an AI answer** — because it is not
 *   one: the server declines without asking a model.
 *
 * The conversation being shown is remembered per story for the browser tab,
 * so closing the reader's sheet to follow a citation and opening it again
 * picks up where it was. Older ones are a picker away; every conversation is
 * private to the reader and deletable.
 *
 * Used on the story page and, through `AskBookSheet`, in the reader. The
 * `reader` variant paints in the reading theme's tokens; see `ask.css`.
 */

const QUESTION_LIMIT = 300

/** "Where I've read to": no bound sent, so the server uses the saved position. */
const AUTO = 'auto'

/** The picker's value for "not one of the earlier conversations". */
const NEW = 'new'

interface AskBookPanelProps {
  storyId: string
  storySlug: string
  /** The chapters this reader can open, in order — the choices for the range. */
  chapters: ReadonlyArray<ChapterSummary>
  /**
   * The range to use until the reader picks one, as a chapter number, or null
   * for "where I've read to". It may change under a mounted panel — the
   * reader turning pages — and the range follows it until the reader makes a
   * choice of their own, which then sticks.
   */
  defaultUpTo: number | null
  variant?: 'page' | 'reader'
  /** Fired when a citation is followed, before the route changes. */
  onCite?: () => void
  autoFocus?: boolean
}

interface Turn {
  key: string
  question: string
  /** What retrieval searched with, when that was not the question as typed. */
  standalone: string | null
  answer: string
  answerable: boolean
  /** Null until the answer has finished: which passages it used is known only then. */
  citations: AskCitation[] | null
  scope: AskScope | null
  status: 'streaming' | 'done' | 'error'
  error: string | null
}

/* Remembering the open conversation -------------------------------------- */

const rememberKey = (storyId: string) => `scribe:ask-conversation:${storyId}`

/** A per-tab convenience; storage that throws or is empty just means "none". */
function recall(storyId: string): string | null {
  try {
    return sessionStorage.getItem(rememberKey(storyId))
  } catch {
    return null
  }
}

function remember(storyId: string, id: string | null): void {
  try {
    if (id) sessionStorage.setItem(rememberKey(storyId), id)
    else sessionStorage.removeItem(rememberKey(storyId))
  } catch {
    /* Not remembering is fine. */
  }
}

/** A stored conversation as turns: each question paired with its answer. */
function turnsOf(conversation: Conversation): Turn[] {
  const turns: Turn[] = []
  const { messages } = conversation
  for (let index = 0; index < messages.length - 1; index += 2) {
    const question = messages[index]
    const answer = messages[index + 1]
    if (question?.role !== 'user' || answer?.role !== 'assistant') continue
    turns.push({
      key: question.id,
      question: question.content,
      standalone: question.standaloneQuestion,
      answer: answer.content,
      answerable: answer.answerable,
      citations: answer.citations,
      scope: answer.scope,
      status: 'done',
      error: null,
    })
  }
  return turns
}

function failureMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.message : fallback
}

/* The panel -------------------------------------------------------------- */

export function AskBookPanel({
  storyId,
  storySlug,
  chapters,
  defaultUpTo,
  variant = 'page',
  onCite,
  autoFocus = false,
}: AskBookPanelProps) {
  const idBase = useId()

  const [question, setQuestion] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  /** Null until the reader chooses; until then the range follows `defaultUpTo`. */
  const [chosenRange, setChosenRange] = useState<string | null>(null)
  const range =
    chosenRange ?? (defaultUpTo === null ? AUTO : String(defaultUpTo))

  const [conversationId, setConversationId] = useState<string | null>(null)
  const [turns, setTurns] = useState<Turn[]>([])
  const [earlier, setEarlier] = useState<ConversationSummary[]>([])
  const [opening, setOpening] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const pending = useRef<AbortController | null>(null)
  const nextKey = useRef(0)
  const lastTurnRef = useRef<HTMLLIElement | null>(null)

  const refreshEarlier = useCallback(
    (signal?: AbortSignal) =>
      listConversations(storyId, signal)
        .then((page) => {
          if (!signal?.aborted) setEarlier(page.items)
        })
        .catch(() => {
          /* The picker is an extra; without it the panel still works. */
        }),
    [storyId],
  )

  /**
   * On open: the earlier conversations for the picker, and the one this tab
   * was last showing, if it still exists. Both quietly absent on failure — a
   * reader who came to ask a question should not meet an error about history.
   */
  useEffect(() => {
    const controller = new AbortController()
    void refreshEarlier(controller.signal)

    const remembered = recall(storyId)
    if (remembered) {
      getConversation(remembered, controller.signal)
        .then((conversation) => {
          if (controller.signal.aborted) return
          setConversationId(conversation.id)
          setTurns(turnsOf(conversation))
        })
        .catch(() => {
          if (!controller.signal.aborted) remember(storyId, null)
        })
    }

    return () => controller.abort()
  }, [storyId, refreshEarlier])

  // Stops the server generating for a reader who has gone.
  useEffect(() => () => pending.current?.abort(), [])

  // Keeps the newest turn in view as it is asked and as it streams in.
  useEffect(() => {
    lastTurnRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [turns.length])

  const patchTurn = (key: string, patch: (turn: Turn) => Partial<Turn>) =>
    setTurns((current) =>
      current.map((turn) => (turn.key === key ? { ...turn, ...patch(turn) } : turn)),
    )

  async function ask(event: React.FormEvent) {
    event.preventDefault()

    const trimmed = question.trim()
    if (trimmed.length < 3) {
      setFormError('Ask a question about the story.')
      return
    }

    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller

    nextKey.current += 1
    const key = `local-${nextKey.current}`
    setTurns((current) => [
      ...current,
      {
        key,
        question: trimmed,
        standalone: null,
        answer: '',
        answerable: true,
        citations: null,
        scope: null,
        status: 'streaming',
        error: null,
      },
    ])
    setQuestion('')
    setFormError(null)
    setConfirmingDelete(false)

    try {
      let id = conversationId
      if (!id) {
        id = (await startConversation(storyId)).id
        setConversationId(id)
        remember(storyId, id)
      }

      for await (const reply of streamConversationMessage(
        id,
        {
          content: trimmed,
          ...(range === AUTO ? {} : { upToChapter: Number(range) }),
        },
        controller.signal,
      )) {
        if (reply.type === 'text') {
          patchTurn(key, (turn) => ({ answer: turn.answer + reply.text }))
        } else if (reply.type === 'done') {
          patchTurn(key, () => ({
            standalone: reply.standaloneQuestion,
            answerable: reply.answerable,
            citations: reply.citations,
            scope: reply.scope,
          }))
        }
      }
      if (controller.signal.aborted) return
      patchTurn(key, () => ({ status: 'done' }))
      void refreshEarlier()
    } catch (cause) {
      if (controller.signal.aborted) return
      // Nothing was stored for a failed turn, so the question goes back in
      // the box to be asked again.
      patchTurn(key, () => ({
        status: 'error',
        error: failureMessage(cause, 'That question could not be answered just now.'),
      }))
      setQuestion(trimmed)
    }
  }

  function startNew() {
    pending.current?.abort()
    setConversationId(null)
    setTurns([])
    setConfirmingDelete(false)
    remember(storyId, null)
  }

  async function open(id: string) {
    if (id === NEW) {
      startNew()
      return
    }
    pending.current?.abort()
    setOpening(true)
    setConfirmingDelete(false)
    try {
      const conversation = await getConversation(id)
      setConversationId(conversation.id)
      setTurns(turnsOf(conversation))
      remember(storyId, conversation.id)
    } catch (cause) {
      setFormError(failureMessage(cause, 'That conversation could not be opened.'))
    } finally {
      setOpening(false)
    }
  }

  async function remove() {
    if (!conversationId) return
    try {
      await deleteConversation(conversationId)
      setEarlier((current) => current.filter((item) => item.id !== conversationId))
      startNew()
    } catch (cause) {
      setFormError(failureMessage(cause, 'That conversation could not be deleted.'))
      setConfirmingDelete(false)
    }
  }

  const titleOf = (number: number | null) =>
    chapters.find((chapter) => chapter.number === number)?.title ??
    `chapter ${number}`

  const last = chapters.at(-1)
  const rangeOptions = [
    { value: AUTO, label: 'Where I’ve read to' },
    ...chapters.map((chapter) => ({
      value: String(chapter.number),
      label:
        chapter === last && chapters.length > 1
          ? 'The whole story (may spoil)'
          : `Through “${chapter.title}”`,
    })),
  ]

  const pickerOptions = [
    { value: NEW, label: 'New conversation' },
    ...earlier.map((item) => ({
      value: item.id,
      label: `${item.title || 'Untitled'} · ${formatRelative(item.updatedAt)}`,
    })),
  ]
  // The open conversation may be too new for the list to have caught up.
  if (conversationId && !earlier.some((item) => item.id === conversationId)) {
    pickerOptions.splice(1, 0, {
      value: conversationId,
      label: turns[0]?.question ?? 'This conversation',
    })
  }

  const streaming = turns.some((turn) => turn.status === 'streaming')

  return (
    <div className={cn('ask', variant === 'reader' && 'ask--reader')}>
      {earlier.length > 0 || turns.length > 0 ? (
        <div className="ask__toolbar">
          <Select
            label="Conversation"
            hideLabel
            size="sm"
            value={conversationId ?? NEW}
            options={pickerOptions}
            disabled={streaming || opening}
            onChange={(value) => void open(value)}
          />
          {turns.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={streaming}
              onClick={startNew}
              startIcon={<Icon name="plus" size="0.95em" />}
            >
              New
            </Button>
          ) : null}
          {conversationId && !confirmingDelete ? (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Delete this conversation"
              title="Delete this conversation"
              disabled={streaming}
              onClick={() => setConfirmingDelete(true)}
              startIcon={<Icon name="trash" size="0.95em" />}
            />
          ) : null}
          {confirmingDelete ? (
            <span className="ask__confirm" role="group" aria-label="Confirm delete">
              <span>Delete this conversation?</span>
              <Button size="sm" variant="danger" onClick={() => void remove()}>
                Delete
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmingDelete(false)}>
                Keep
              </Button>
            </span>
          ) : null}
        </div>
      ) : null}

      {turns.length > 0 ? (
        <ol className="ask__thread" aria-label="This conversation" aria-busy={streaming}>
          {turns.map((turn, index) => (
            <li
              key={turn.key}
              className="ask__turn"
              ref={index === turns.length - 1 ? lastTurnRef : undefined}
            >
              <AnswerTurn
                turn={turn}
                idBase={`${idBase}-${turn.key}`}
                storySlug={storySlug}
                onCite={onCite}
                scopeText={
                  turn.scope
                    ? scopeNote(turn.scope, titleOf, turn.scope.upToChapter === last?.number)
                    : null
                }
              />
            </li>
          ))}
        </ol>
      ) : null}

      <form className="ask__form" onSubmit={ask}>
        <div className="ask__row">
          <TextField
            label={turns.length > 0 ? 'Ask a follow-up' : 'Your question'}
            hideLabel
            placeholder={
              turns.length > 0
                ? 'Ask a follow-up — “what happened after that?” works…'
                : 'Ask about a character, a place, or something that happened…'
            }
            value={question}
            maxLength={QUESTION_LIMIT}
            disabled={streaming}
            autoFocus={autoFocus}
            onChange={(event) => {
              setQuestion(event.target.value)
              setFormError(null)
            }}
          />
          <Button
            variant="primary"
            type="submit"
            loading={streaming}
            startIcon={<Icon name="send" size="0.95em" />}
          >
            Ask
          </Button>
        </div>

        {formError ? <p className="ask__error">{formError}</p> : null}

        {chapters.length > 1 ? (
          <div className="ask__range">
            <span className="ask__range-label" aria-hidden="true">
              Answer from
            </span>
            <Select
              label="Answer from"
              hideLabel
              size="sm"
              value={range}
              options={rangeOptions}
              disabled={streaming}
              onChange={setChosenRange}
            />
          </div>
        ) : null}
      </form>
    </div>
  )
}

/* One turn --------------------------------------------------------------- */

interface AnswerTurnProps {
  turn: Turn
  idBase: string
  storySlug: string
  onCite: (() => void) | undefined
  scopeText: string | null
}

function AnswerTurn({ turn, idBase, storySlug, onCite, scopeText }: AnswerTurnProps) {
  const valid = turn.citations
    ? new Set(turn.citations.map((citation) => citation.marker))
    : null

  /** Moves focus to a cited passage, so a marker in the answer leads somewhere. */
  function showCitation(marker: number) {
    const item = document.getElementById(`${idBase}-cite-${marker}`)
    item?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    item?.querySelector('a')?.focus({ preventScroll: true })
  }

  return (
    <>
      <p className="ask__question">{turn.question}</p>

      {turn.status === 'streaming' && turn.answer.length === 0 ? (
        <p className="ask__hint">Looking through the story…</p>
      ) : null}

      {turn.error ? <p className="ask__error">{turn.error}</p> : null}

      {turn.answer.length > 0 ? (
        <p className={cn('ask__answer', !turn.answerable && 'is-declined')}>
          {segmentAnswer(turn.answer, valid).map((segment, index) =>
            segment.kind === 'text' ? (
              <span key={index}>{withEmphasis(segment.text)}</span>
            ) : (
              <span key={index} className="ask__markers">
                {segment.markers.map((marker) =>
                  valid ? (
                    <button
                      key={marker}
                      type="button"
                      className="ask__marker"
                      aria-label={`Passage ${marker}`}
                      onClick={() => showCitation(marker)}
                    >
                      {marker}
                    </button>
                  ) : (
                    <span key={marker} className="ask__marker is-pending">
                      {marker}
                    </span>
                  ),
                )}
              </span>
            ),
          )}
        </p>
      ) : null}

      {/* What retrieval searched for, when it was not the question as typed:
          the first thing to check when a follow-up's answer misses. */}
      {turn.standalone && turn.standalone !== turn.question ? (
        <p className="ask__searched">
          <Icon name="search" size="0.85em" /> Searched for “{turn.standalone}”
        </p>
      ) : null}

      {turn.citations && turn.citations.length > 0 ? (
        <ol className="ask__citations" aria-label="Passages this answer cites">
          {turn.citations.map((citation) => (
            <li key={citation.marker} id={`${idBase}-cite-${citation.marker}`}>
              <Link
                className="ask__citation"
                to={`/read/${storySlug}/${citation.chapterNumber}`}
                onClick={onCite}
              >
                <span className="ask__citation-marker">{citation.marker}</span>
                <span className="ask__citation-body">
                  {/* The chapter's own title, not its number beside it:
                      authors number their titles themselves. */}
                  <span className="ask__citation-chapter">{citation.chapterTitle}</span>
                  <span className="ask__citation-quote">{citation.quote}</span>
                </span>
                <Icon name="chevron-right" size="0.9rem" />
              </Link>
            </li>
          ))}
        </ol>
      ) : null}

      {turn.status === 'done' && scopeText ? (
        <p className="ask__note">
          {scopeText}
          {turn.answerable
            ? turn.citations && turn.citations.length > 0
              ? ' AI-generated — check it against the passages above.'
              : ' AI-generated, and it cites no passage, so there is nothing to check it against. Treat it with care.'
            : null}
        </p>
      ) : null}
    </>
  )
}

/**
 * `**bold**` as bold, and nothing else of markdown.
 *
 * The prompt asks for plain text and gpt-oss bolded quoted dialogue anyway
 * when checked against it on Groq. Showing the asterisks reads
 * as a bug; a markdown renderer would be a lot of surface for one mark. An
 * unclosed `**` mid-stream stays as written until its partner arrives.
 */
function withEmphasis(text: string): React.ReactNode[] {
  return text
    .split(/\*\*([^*\n]+)\*\*/g)
    .map((part, index) =>
      index % 2 === 1 ? <strong key={index}>{part}</strong> : part,
    )
}

/** Which chapters an answer was drawn from, in the reader's terms. */
function scopeNote(
  scope: AskScope,
  titleOf: (number: number | null) => string,
  reachesEnd: boolean,
): string {
  if (scope.basis === 'author') {
    return 'Your own story, so every chapter was searched, drafts included.'
  }
  if (scope.upToChapter === null || reachesEnd) {
    return 'Searched the whole story.'
  }

  const through = `“${titleOf(scope.upToChapter)}”`
  if (scope.basis === 'progress') {
    return `Searched up to ${through}, where you’ve read to.`
  }
  if (scope.basis === 'start') {
    return `You haven’t started this story, so only ${through} was searched — choose a later chapter to widen it.`
  }
  return `Searched up to ${through}.`
}
