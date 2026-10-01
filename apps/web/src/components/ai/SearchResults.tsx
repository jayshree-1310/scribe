import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { formatCount } from '../../lib/format'
import {
  searchStories,
  type SearchBasis,
  type SearchResult,
} from '../../data/ai-api'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { EmptyState, ErrorState } from '../ui/States'
import { StoryCard, StoryCardSkeleton } from '../story/StoryCard'
import './search.css'

const PAGE_SIZE = 8

/**
 * Why a result is on the list, in the reader's terms.
 *
 * Derived from the ranks the API returns rather than written by a model: a
 * passage is shown when meaning matched, and a keyword-only result says that
 * it matched on its title or author, because a result with no visible reason
 * reads as noise.
 */
function MatchReason({ story }: { story: SearchResult }) {
  if (story.passages.length > 0) {
    return (
      <div className="search-result__passages">
        {story.passages.map((passage) => (
          <figure key={passage.chapterId} className="search-result__passage">
            <blockquote>{passage.excerpt}</blockquote>
            <figcaption>
              <Link to={`/read/${story.slug}/${passage.chapterNumber}`}>
                Chapter {passage.chapterNumber}
                {passage.chapterTitle ? ` · ${passage.chapterTitle}` : ''}
              </Link>
            </figcaption>
          </figure>
        ))}
      </div>
    )
  }

  return <p className="search-result__reason">Matched on its title or author.</p>
}

/**
 * Scribe stories found by hybrid search: title and author, and what their
 * chapters are about.
 *
 * Owns its own paging so `DiscoverPage` only has to decide *whether* to show
 * it. The catalogue grid beside it keeps its keyword search -- only authored
 * stories have chapters to embed.
 */
export function SearchResults({
  query,
  genreId,
}: {
  query: string
  genreId: string | null
}) {
  const filterKey = JSON.stringify({ query, genreId })
  const [request, setRequest] = useState({ key: filterKey, page: 1 })
  const [items, setItems] = useState<SearchResult[]>([])
  const [meta, setMeta] = useState<{
    total: number
    hasMore: boolean
    basis: SearchBasis
  } | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)

  // Reset during render, as `DiscoverPage` does, so a superseded page can
  // never be appended to a fresh result set.
  if (request.key !== filterKey) {
    setRequest({ key: filterKey, page: 1 })
    setItems([])
    setMeta(null)
    setStatus('loading')
    setError(null)
  }

  useEffect(() => {
    const controller = new AbortController()

    searchStories(
      { q: query, genreId, page: request.page, limit: PAGE_SIZE },
      controller.signal,
    )
      .then((page) => {
        setItems((current) =>
          request.page === 1 ? page.items : [...current, ...page.items],
        )
        setMeta({ total: page.total, hasMore: page.hasMore, basis: page.basis })
        setStatus('ready')
        setError(null)
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setStatus('error')
        setError(
          cause instanceof Error ? cause.message : 'That search did not finish.',
        )
      })

    return () => controller.abort()
    // `request` carries both the filter identity and the page number.
  }, [request, query, genreId])

  return (
    <section className="rail search-results" aria-labelledby="search-results-title">
      <header className="rail__head">
        <h2 className="rail__title" id="search-results-title">
          Written on Scribe
        </h2>
        <p className="rail__desc">
          Matched on title and author, and on what their chapters are about.
        </p>
      </header>

      {meta?.basis === 'keyword' ? (
        <p className="search-results__notice" role="status">
          <Icon name="info" size="1em" />
          Searching by meaning is unavailable right now, so these match on
          title and author only.
        </p>
      ) : null}

      {status === 'error' ? (
        <ErrorState
          message={error}
          onRetry={() => {
            setStatus('loading')
            setRequest((current) => ({ ...current }))
          }}
        />
      ) : status === 'loading' && items.length === 0 ? (
        <ol className="search-results__list" aria-busy="true">
          {Array.from({ length: 3 }, (_, index) => (
            <li key={index} className="search-result">
              <StoryCardSkeleton variant="row" />
            </li>
          ))}
        </ol>
      ) : items.length === 0 ? (
        <EmptyState
          icon="search"
          title="No Scribe story matched"
          description="Nothing here is about that yet — by title, author or meaning."
        />
      ) : (
        <>
          <p className="search-results__count" role="status">
            {formatCount(meta?.total ?? items.length)}{' '}
            {(meta?.total ?? items.length) === 1 ? 'story' : 'stories'}
          </p>

          <ol className="search-results__list">
            {items.map((story) => (
              <li key={story.id} className="search-result">
                <StoryCard story={story} variant="row" />
                <MatchReason story={story} />
              </li>
            ))}
          </ol>

          {meta?.hasMore ? (
            <div className="results__more">
              <Button
                variant="secondary"
                loading={status === 'loading'}
                onClick={() => {
                  setStatus('loading')
                  setRequest((current) => ({ ...current, page: current.page + 1 }))
                }}
              >
                More stories
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}
