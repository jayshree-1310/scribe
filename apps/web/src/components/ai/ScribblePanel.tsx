import { useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { askScribble, type ScribbleReply } from '../../data/ai-api'
import { ApiError } from '../../lib/api-client'
import { formatRating } from '../../lib/format'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Stars } from '../ui/Rating'
import { BookCover } from '../books/BookCover'
import './scribble.css'

/**
 * Scribble: ask for a kind of book, get real ones back.
 *
 * Everything except `intro` and `reason` came out of Scribe's database, and
 * the panel says so — an AI notice on the list, and the reason rendered as a
 * quoted aside rather than as the book's own blurb. Nothing generated is
 * presented as an author's words.
 */

const SUGGESTIONS = [
  'Fantasy books for kids',
  'Something short and finished',
  'A mystery to read this weekend',
]

export function ScribblePanel() {
  const [message, setMessage] = useState('')
  const [reply, setReply] = useState<ScribbleReply | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  /**
   * Abandons the previous answer when a second question is asked. Without it a
   * slow first reply can land after a fast second one and overwrite it.
   */
  const pending = useRef<AbortController | null>(null)

  async function ask(question: string) {
    const trimmed = question.trim()
    if (trimmed.length === 0) return

    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller

    setStatus('loading')
    setError(null)

    try {
      const answer = await askScribble(trimmed, controller.signal)
      if (controller.signal.aborted) return
      setReply(answer)
      setStatus('idle')
    } catch (cause) {
      if (controller.signal.aborted) return
      setError(
        cause instanceof ApiError
          ? cause.message
          : 'Scribble could not answer just now.',
      )
      setStatus('error')
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    void ask(message)
  }

  const loading = status === 'loading'

  return (
    <section className="scribble" aria-labelledby="scribble-heading">
      <header className="scribble__head">
        <Icon name="sparkle" className="scribble__mark" />
        <div>
          <h2 id="scribble-heading" className="scribble__title">
            Ask Scribble
          </h2>
          <p className="scribble__sub">
            Describe what you feel like reading. Every suggestion is a real
            title from Scribe&rsquo;s library.
          </p>
        </div>
      </header>

      <form className="scribble__form" onSubmit={onSubmit}>
        <label className="visually-hidden" htmlFor="scribble-input">
          What would you like to read?
        </label>
        <input
          id="scribble-input"
          className="scribble__input"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Fantasy books for kids&hellip;"
          maxLength={500}
          disabled={loading}
        />
        <Button type="submit" variant="primary" loading={loading}>
          Ask
        </Button>
      </form>

      {reply === null && status !== 'error' && !loading ? (
        <ul className="scribble__suggestions">
          {SUGGESTIONS.map((suggestion) => (
            <li key={suggestion}>
              <button
                type="button"
                className="scribble__suggestion"
                onClick={() => {
                  setMessage(suggestion)
                  void ask(suggestion)
                }}
              >
                {suggestion}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {loading ? (
        <p className="scribble__status" role="status">
          Reading the shelves&hellip;
        </p>
      ) : null}

      {status === 'error' && error !== null ? (
        <p className="scribble__error" role="alert">
          {error}
        </p>
      ) : null}

      {reply !== null && !loading ? (
        <ScribbleAnswer reply={reply} />
      ) : null}
    </section>
  )
}

function ScribbleAnswer({ reply }: { reply: ScribbleReply }) {
  const { recommendations } = reply

  return (
    <div className="scribble__answer">
      {reply.intro ? <p className="scribble__intro">{reply.intro}</p> : null}

      {recommendations.length === 0 ? null : (
        <>
          <ol className="scribble__list">
            {recommendations.map((item) => (
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
                    size="sm"
                  />
                </Link>

                <div className="scribble__body">
                  <h3 className="scribble__book-title">
                    <Link to={item.url}>{item.title}</Link>
                  </h3>
                  <p className="scribble__byline">
                    {item.author.displayName ?? item.author.username}
                    {item.ratingAverage !== null ? (
                      <>
                        {' · '}
                        <Stars value={item.ratingAverage} size="sm" />
                        <span className="scribble__rating">
                          {formatRating(item.ratingAverage)}
                        </span>
                      </>
                    ) : null}
                  </p>

                  {item.description ? (
                    <p className="scribble__blurb">{item.description}</p>
                  ) : null}

                  {/* Marked as generated, and visually separate from the
                      author's own description directly above it. */}
                  {item.reason ? (
                    <p className="scribble__reason">
                      <span className="scribble__reason-tag">
                        Scribble&rsquo;s take
                      </span>
                      {item.reason}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>

          <p className="scribble__disclaimer">
            Titles and descriptions come from Scribe&rsquo;s library. The
            comments on each are AI-generated and can be wrong.
          </p>
        </>
      )}
    </div>
  )
}
