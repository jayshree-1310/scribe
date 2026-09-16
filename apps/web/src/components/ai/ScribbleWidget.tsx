import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { Link } from 'react-router-dom'
import {
  streamScribble,
  type ScribbleContext,
  type ScribbleEvent,
  type ScribbleRecommendation,
  type ScribbleReply,
} from '../../data/ai-api'
import { cn } from '../../lib/cn'
import { Icon } from '../ui/Icon'
import { BookCover } from '../books/BookCover'
import './scribble.css'

/**
 * Scribble: a docked assistant that answers "what should I read?" with real
 * titles from Scribe's library.
 *
 * Everything about a book except `reason` came out of the database. The
 * generated sentence is labelled on every card, because nothing AI-written may
 * read as an author's own words.
 *
 * Lives in `AppShell`, so it follows the reader from page to page and keeps
 * its conversation across navigations — the shell does not remount.
 */

/** The three headline prompts, each a real query the intent stage can read. */
const EXAMPLES = [
  {
    icon: 'sparkle',
    tone: 'violet',
    title: 'Fantasy books for kids',
    blurb: 'Magical adventures and imaginative worlds',
  },
  {
    icon: 'clock',
    tone: 'peach',
    title: 'Something short and finished',
    blurb: 'Quick reads you can complete soon',
  },
  {
    icon: 'search',
    tone: 'mint',
    title: 'A mystery for the weekend',
    blurb: 'Suspenseful stories to keep you hooked',
  },
] as const

/**
 * Secondary prompts. Phrased as the reader would say them rather than as
 * filter names, because they are sent to the model verbatim.
 */
const EXPLORE = [
  'Highest rated books',
  'Award winners',
  'Book club picks',
  'New releases',
  'Feel-good reads',
]

/**
 * Where the conversation is kept between visits.
 *
 * Per-browser and per-origin: it survives a reload and reopening the panel,
 * and reaches no other device and no server. Real cross-device history needs
 * conversation tables (Task AI 10 in `docs/AI-BACKLOG.md`); this is the half
 * that costs nothing and loses nothing today.
 */
const STORAGE_KEY = 'scribble:conversation'

/** Bounds what a long session can accumulate in a 5MB store. */
const KEPT_TURNS = 12

function loadTurns(): Turn[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return []

    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    // Written by an older build, or hand-edited: keep only what still fits
    // the shape, and never restore a turn as mid-flight.
    return parsed
      .filter(
        (turn): turn is Turn =>
          typeof turn === 'object' &&
          turn !== null &&
          typeof (turn as Turn).id === 'number' &&
          typeof (turn as Turn).question === 'string',
      )
      .map((turn) => ({ ...turn, streaming: false }))
      .slice(-KEPT_TURNS)
  } catch {
    // Private windows, cleared site data, quota errors: a missing history is
    // not worth failing the widget over.
    return []
  }
}

function saveTurns(turns: Turn[]): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(turns.slice(-KEPT_TURNS)),
    )
  } catch {
    /* Storage full or unavailable; the conversation just will not persist. */
  }
}

interface Turn {
  id: number
  question: string
  reply: ScribbleReply | null
  error: string | null
  /** True until the terminal `done` frame lands. */
  streaming: boolean
}

const EMPTY_REPLY: ScribbleReply = {
  intro: '',
  recommendations: [],
  interpreted: {
    genre: null,
    kidsAppropriate: false,
    completed: null,
    search: null,
    droppedSearch: null,
  },
}

/**
 * Folds one server frame into the turn it belongs to.
 *
 * The order matters to how this feels: `candidates` carries the cards, which
 * come out of the database and so arrive before the model has written a word.
 * The reasons then fill in one at a time. A local model takes tens of seconds
 * to finish a reply; this is the difference between watching a spinner for all
 * of it and seeing real books immediately.
 */
function applyEvent(turn: Turn, event: ScribbleEvent): Turn {
  const reply = turn.reply ?? EMPTY_REPLY

  switch (event.type) {
    case 'meta':
      return { ...turn, reply: { ...reply, interpreted: event.interpreted } }

    case 'candidates':
      return { ...turn, reply: { ...reply, recommendations: event.candidates } }

    case 'intro':
      return { ...turn, reply: { ...reply, intro: event.text } }

    case 'pick':
      return {
        ...turn,
        reply: {
          ...reply,
          recommendations: reply.recommendations.map(
            (item): ScribbleRecommendation =>
              item.id === event.id ? { ...item, reason: event.reason } : item,
          ),
        },
      }

    // The authority: the server re-validated the whole reply, so anything the
    // incremental frames got optimistically wrong is corrected here.
    case 'done':
      return { ...turn, reply: event.reply, streaming: false }

    default:
      return turn
  }
}

/**
 * What a reader is told when a question fails.
 *
 * Deliberately not the server's own message. The API names the fix in its 503
 * — "start it with `docker compose --profile ai up -d ollama`" — because that
 * failure is nearly always local setup and a developer reading a log or a
 * response needs it. A reader is not the one who can act on it, and a shell
 * command in a chat bubble is alarming rather than helpful. The precise cause
 * stays in the response body and the API logs; this is the reader's half.
 */
function readerMessage(error: unknown): string {
  // Read the shape rather than `instanceof ApiError`. Under Vite's HMR the
  // client module can be evaluated twice, leaving two distinct `ApiError`
  // classes -- the one thrown and the one imported here -- so the instance
  // check fails and every failure collapses to the generic sentence. The
  // fields are what carry the meaning; the class is not.
  const detail =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown; status?: unknown; message?: unknown })
      : null

  const code = typeof detail?.code === 'string' ? detail.code : null
  const status = typeof detail?.status === 'number' ? detail.status : null

  if (code === null && status === null) {
    return 'Scribble could not answer just now. Please try again.'
  }

  switch (code) {
    case 'service_unavailable':
      return 'Scribble is having a rest and cannot answer right now. Please try again a little later.'
    case 'too_many_requests':
      return 'That is a lot of questions in a short time. Give it a minute and ask me again.'
    case 'upstream_error':
      return 'I lost my train of thought there. Try asking that a different way?'
    case 'request_timeout':
      return 'That one took me too long to think about. Try again, or ask something narrower.'
    case 'network_error':
      return "I couldn't reach the library just now. Check your connection and try again."
    case 'unauthorized':
      return 'Please sign in again to ask Scribble.'
    default:
      // A validation message is written for a person and is safe to show.
      return status === 400 && typeof detail?.message === 'string'
        ? detail.message
        : 'Scribble could not answer just now. Please try again.'
  }
}

export function ScribbleWidget() {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  // Read once on mount rather than in a `useEffect`, so a returning reader
  // never sees the panel flash empty before their history appears.
  const [turns, setTurns] = useState<Turn[]>(loadTurns)

  // Mirrors `turns` for reads inside async callbacks, which would otherwise
  // close over whatever the state was when the callback was created.
  const turnsRef = useRef<Turn[]>(turns)
  const nextId = useRef(
    turns.reduce((highest, turn) => Math.max(highest, turn.id), 0) + 1,
  )
  const inflight = useRef<AbortController | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const panel = useRef<HTMLElement>(null)
  const launcher = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)

  const busy = turns.some((turn) => turn.streaming)

  // Esc closes, matching the navigation drawer in `AppShell`.
  useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  /**
   * Clicking away closes it, the way a popover should. `pointerdown` rather
   * than `click` so a drag that starts inside and ends outside — selecting an
   * answer to copy it — does not count as clicking away.
   */
  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node
      if (panel.current?.contains(target)) return
      if (launcher.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  // Focus the input on open, and hand focus back to the launcher on close —
  // otherwise closing drops the caret at the top of the document.
  useEffect(() => {
    if (open) input.current?.focus()
    else if (wasOpen.current) launcher.current?.focus()
    wasOpen.current = open
  }, [open])

  useEffect(() => {
    turnsRef.current = turns
  }, [turns])

  // Persist once a turn settles. Writing mid-stream would store a half-filled
  // answer and churn the store on every delta.
  useEffect(() => {
    if (turns.some((turn) => turn.streaming)) return
    saveTurns(turns)
  }, [turns])

  // Keep the newest turn in view as answers land.
  useEffect(() => {
    const node = scroller.current
    if (node) node.scrollTop = node.scrollHeight
  }, [turns])

  // A widget that unmounts mid-flight must not leave the model generating
  // tokens nobody will read.
  useEffect(() => () => inflight.current?.abort(), [])

  async function ask(question: string) {
    const trimmed = question.trim()
    if (trimmed.length === 0) return

    // A new question supersedes one still in flight rather than being refused.
    // Gating on `busy` meant any path that left a turn marked streaming locked
    // the composer for good; this way there is nothing to deadlock.
    inflight.current?.abort()
    const controller = new AbortController()
    inflight.current = controller

    setMessage('')

    const id = nextId.current++
    // Added before the request so the reader's own words appear immediately.
    setTurns((current) => [
      ...current,
      { id, question: trimmed, reply: null, error: null, streaming: true },
    ])

    /**
     * What the last answered turn settled on, so "which of those are
     * thrillers" narrows it instead of starting over. Read at send time rather
     * than from the render closure, so a question typed while an answer is
     * still arriving refines the turn before it, not a half-filled one.
     */
    const carriedContext = (): ScribbleContext | undefined => {
      const last = [...turnsRef.current]
        .reverse()
        .find((turn) => turn.reply !== null && !turn.streaming)
      if (!last?.reply) return undefined

      const { genre, kidsAppropriate, completed, search } =
        last.reply.interpreted
      // Nothing carried forward is nothing to refine.
      if (genre === null && search === null && !kidsAppropriate) {
        return completed === null ? undefined : { ...last.reply.interpreted }
      }
      return { genre, kidsAppropriate, completed, search }
    }

    const update = (change: (turn: Turn) => Turn) =>
      setTurns((current) =>
        current.map((turn) => (turn.id === id ? change(turn) : turn)),
      )

    try {
      for await (const event of streamScribble(
        trimmed,
        carriedContext(),
        controller.signal,
      )) {
        if (controller.signal.aborted) return
        update((turn) => applyEvent(turn, event))
      }
      // A stream that ended without `done` failed: the socket can close
      // mid-generation and a reader cannot tell that from success.
      update((turn) =>
        turn.streaming
          ? {
              ...turn,
              streaming: false,
              error:
                turn.error ??
                'I stopped partway through that one. Please try again.',
            }
          : turn,
      )
    } catch (cause) {
      if (controller.signal.aborted) return
      update((turn) => ({
        ...turn,
        streaming: false,
        error: readerMessage(cause),
      }))
    } finally {
      /**
       * Whatever happened -- finished, failed, or abandoned for a newer
       * question -- this turn has stopped streaming. Without this the two
       * `aborted` returns above skip the flag, `busy` stays true forever and
       * the composer is disabled for the rest of the session.
       */
      update((turn) => (turn.streaming ? { ...turn, streaming: false } : turn))
      if (inflight.current === controller) inflight.current = null
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    void ask(message)
  }

  return (
    <>
      {/* Hidden while the panel is open: the panel has its own close control,
          and a second one floating beneath it just reads as clutter. */}
      <button
        ref={launcher}
        type="button"
        className={cn('scribble-fab', open && 'is-hidden')}
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-controls="scribble-panel"
      >
        {/* A speech bubble, not the sparkle this had: a launcher is read at a
            glance from across the page, and the bubble is the one shape every
            reader already knows means "talk to something here". */}
        <Icon name="comment" size="1.5rem" />
        <span className="visually-hidden">
          Ask Scribble for a reading suggestion
        </span>
      </button>

      <section
        ref={panel}
        id="scribble-panel"
        className={cn('scribble', open && 'is-open')}
        aria-label="Ask Scribble"
        aria-hidden={!open}
        inert={open ? undefined : true}
      >
        <header className="scribble__head">
          <span className="scribble__avatar" aria-hidden="true">
            📖
          </span>
          <div className="scribble__heading">
            <h2 className="scribble__title">Scribble</h2>
            <p className="scribble__sub">Your reading companion</p>
          </div>

          {/* Says where the answers come from. The claim is literal: every
              recommendation is a row from Scribe's own catalogue. */}
          <span className="scribble__status-pill">
            <span className="scribble__dot" aria-hidden="true" />
            Using your library
          </span>

          {turns.length > 0 ? (
            <button
              type="button"
              className="scribble__reset"
              onClick={() => {
                setTurns([])
                saveTurns([])
              }}
            >
              Clear
            </button>
          ) : null}
          <button
            type="button"
            className="scribble__close"
            onClick={() => setOpen(false)}
          >
            <Icon name="close" size="1.1rem" />
            <span className="visually-hidden">Close</span>
          </button>
        </header>

        <div className="scribble__scroll" ref={scroller}>
          {turns.length === 0 && !busy ? (
            <div className="scribble__welcome">
              <div className="scribble__greeting">
                <div>
                  <h3 className="scribble__greeting-title">
                    Hi there! <span aria-hidden="true">👋</span>
                  </h3>
                  <p className="scribble__greeting-body">
                    Tell me what you&rsquo;d like to read. Every suggestion is a
                    real title from Scribe&rsquo;s library.
                  </p>
                </div>
                <span className="scribble__greeting-art" aria-hidden="true">
                  📚
                </span>
              </div>

              <h4 className="scribble__section">Try some examples</h4>
              <ul className="scribble__examples">
                {EXAMPLES.map((example) => (
                  <li key={example.title}>
                    <button
                      type="button"
                      className={`scribble__example scribble__example--${example.tone}`}
                      onClick={() => void ask(example.title)}
                    >
                      <span className="scribble__example-top">
                        <Icon
                          name={example.icon}
                          className="scribble__example-icon"
                          size="1.05rem"
                        />
                        <Icon
                          name="arrow-right"
                          className="scribble__example-go"
                          size="0.95rem"
                        />
                      </span>
                      <span className="scribble__example-title">
                        {example.title}
                      </span>
                      <span className="scribble__example-blurb">
                        {example.blurb}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>

              <h4 className="scribble__section">Explore more</h4>
              <ul className="scribble__chips">
                {EXPLORE.map((prompt) => (
                  <li key={prompt}>
                    <button
                      type="button"
                      className="scribble__chip"
                      onClick={() => void ask(prompt)}
                    >
                      {prompt}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="scribble__log" aria-live="polite">
            {turns.map((turn) => (
              <TurnView key={turn.id} turn={turn} />
            ))}
          </div>
        </div>

        <div className="scribble__footer">
          <form className="scribble__form" onSubmit={onSubmit}>
            <label className="visually-hidden" htmlFor="scribble-input">
              What would you like to read?
            </label>
            <input
              id="scribble-input"
              ref={input}
              className="scribble__input"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Ask for a book, genre, mood, or anything…"
              maxLength={500}
            />
            <button
              type="submit"
              className="scribble__send"
              disabled={message.trim().length === 0}
            >
              <Icon name="send" size="1rem" />
              <span className="visually-hidden">Ask</span>
            </button>
          </form>
        </div>
      </section>
    </>
  )
}

function TurnView({ turn }: { turn: Turn }) {
  const waiting =
    turn.streaming && (turn.reply?.recommendations.length ?? 0) === 0

  return (
    <>
      <p className="scribble__question">{turn.question}</p>

      {waiting ? (
        <FromScribble>
          <p className="scribble__thinking">
            Reading the shelves<span className="scribble__dots" />
          </p>
        </FromScribble>
      ) : null}

      {turn.error !== null ? (
        <FromScribble>
          <p className="scribble__error">
            <Icon name="alert" size="0.95rem" aria-hidden="true" />
            <span>{turn.error}</span>
          </p>
        </FromScribble>
      ) : null}

      {turn.reply !== null ? (
        <FromScribble>
          {turn.reply.intro ? (
            <p className="scribble__intro">{turn.reply.intro}</p>
          ) : null}

          {/* Substitutes are never presented as the thing that was asked for. */}
          {turn.reply.interpreted.droppedSearch !== null ? (
            <p className="scribble__substitute">
              I couldn&rsquo;t find anything for &ldquo;
              {turn.reply.interpreted.droppedSearch}&rdquo; in the library.
              These are the closest I could find.
            </p>
          ) : null}

          {/* While the model is still choosing, these are the shelf it is
              choosing *from* — not yet an answer, and labelled as such. */}
          {turn.streaming && turn.reply.recommendations.length > 0 ? (
            <p className="scribble__considering">Looking through these&hellip;</p>
          ) : null}

          {turn.reply.recommendations.length > 0 ? (
            <>
              <ul className="scribble__list">
                {turn.reply.recommendations.map((item) => (
                  <li key={item.id} className="scribble__item">
                    <Link to={item.url} className="scribble__cover-link">
                      <BookCover
                        book={{
                          id: item.id,
                          title: item.title,
                          coverUrl: item.coverUrl,
                          genres: item.genres,
                          author: { id: item.id, username: item.author.username },
                        }}
                        size="xs"
                      />
                    </Link>

                    <div className="scribble__body">
                      <h3 className="scribble__book-title">
                        <Link to={item.url}>{item.title}</Link>
                      </h3>
                      <p className="scribble__byline">
                        {item.author.displayName ?? item.author.username}
                      </p>
                      {/* Marked as generated: a machine's opinion must never
                          read as the author's own blurb. */}
                      {item.reason ? (
                        <p className="scribble__reason">{item.reason}</p>
                      ) : !turn.streaming && item.description ? (
                        <p className="scribble__reason scribble__reason--blurb">
                          {item.description}
                        </p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
              {turn.streaming ? null : (
                <p className="scribble__disclaimer">
                  Titles come from Scribe&rsquo;s library; the notes are
                  AI-generated and can be wrong.
                </p>
              )}
            </>
          ) : null}
        </FromScribble>
      ) : null}
    </>
  )
}

/**
 * One message from Scribble: avatar, then bubble. Keeps the assistant's side
 * of the conversation visually distinct from the reader's, which is the whole
 * reason a chat reads as a chat.
 */
function FromScribble({ children }: { children: ReactNode }) {
  return <div className="scribble__from-bot">{children}</div>
}
