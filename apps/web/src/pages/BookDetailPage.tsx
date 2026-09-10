import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { CSSProperties } from 'react'
import { useAsync } from '../hooks/useAsync'
import { genreChipStyle } from '../lib/cover'
import { formatCount, formatDate, formatRating } from '../lib/format'
import * as books from '../data/books-api'
import {
  READING_STATUS_LABELS,
  authorName,
  type Book,
  type ReadingStatus,
} from '../types/books'
import { AppShell } from '../components/layout/AppShell'
import { ButtonLink } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { Stars } from '../components/ui/Rating'
import { Skeleton } from '../components/ui/Skeleton'
import { EmptyState, ErrorState } from '../components/ui/States'
import { BookCard, BookCardSkeleton } from '../components/books/BookCard'
import { BookCover } from '../components/books/BookCover'
import { ShelfMenu } from '../components/books/ShelfMenu'
import './pages.css'
import '../components/books/books.css'

/** One row of the publication table; renders nothing without a value. */
function Fact({ label, value }: { label: string; value: string | null }) {
  if (!value) return null

  return (
    <div className="book-facts__row">
      <dt className="book-facts__label">{label}</dt>
      <dd className="book-facts__value">{value}</dd>
    </div>
  )
}

function DetailSkeleton() {
  return (
    <div className="book-detail" aria-busy="true">
      <div className="book-detail__aside">
        <Skeleton height="20rem" radius="var(--radius-md)" />
      </div>
      <div className="book-detail__main">
        <Skeleton width="30%" height="1rem" />
        <Skeleton width="80%" height="2.25rem" />
        <Skeleton width="40%" height="1rem" />
        <Skeleton height="0.85rem" />
        <Skeleton height="0.85rem" />
        <Skeleton width="65%" height="0.85rem" />
      </div>
    </div>
  )
}

export function BookDetailPage() {
  const { id = '' } = useParams<{ id: string }>()

  const book = useAsync(() => books.getBook(id), [id])
  const related = useAsync(() => books.getRelatedBooks(id), [id])

  // The shelf is held locally so the whole page reacts to a change made in
  // either control, without refetching the book. It adopts the loaded book's
  // shelf during render — keyed by book id, the way `useAsync` resets itself —
  // so a local change survives until a *different* book loads.
  const loadedId = book.status === 'ready' && book.data ? book.data.id : null
  const [shelf, setShelf] = useState<{ id: string | null; status: ReadingStatus | null }>(
    { id: null, status: null },
  )

  if (loadedId !== null && shelf.id !== loadedId) {
    setShelf({ id: loadedId, status: book.data?.libraryStatus ?? null })
  }

  const status = shelf.status

  function setStatus(next: ReadingStatus | null): void {
    setShelf({ id: loadedId, status: next })
  }

  /**
   * A local copy of the related books, so shelving one from the rail updates
   * that card immediately. `source` tracks which response the copy came from,
   * so a fresh load replaces it while local edits survive re-renders.
   */
  const [relatedBooks, setRelatedBooks] = useState<{
    source: Book[]
    books: Book[]
  } | null>(null)

  if (related.status === 'ready' && related.data && relatedBooks?.source !== related.data) {
    setRelatedBooks({ source: related.data, books: related.data })
  }

  function setRelatedStatus(bookId: string, next: ReadingStatus | null): void {
    setRelatedBooks((current) =>
      current === null
        ? current
        : {
            ...current,
            books: current.books.map((book) =>
              book.id === bookId ? { ...book, libraryStatus: next } : book,
            ),
          },
    )
  }

  if (book.status === 'loading') {
    return (
      <AppShell>
        <DetailSkeleton />
      </AppShell>
    )
  }

  if (book.status === 'error' || !book.data) {
    // A missing book is an ordinary outcome, not a failure to report as one.
    // `useAsync` reduces the rejection to its message, so match on that: the
    // API answers 404 with "That book could not be found.", and the fetch
    // wrapper's own 404 copy reads "we couldn't find".
    const missing =
      book.error !== null &&
      (book.error.includes('could not be found') ||
        book.error.includes("couldn't find"))

    return (
      <AppShell>
        {missing ? (
          <EmptyState
            icon="book"
            title="We couldn't find that book"
            description="It may have been removed from the catalogue."
            action={<ButtonLink to="/discover">Back to Discover</ButtonLink>}
          />
        ) : (
          <ErrorState message={book.error} onRetry={book.reload} />
        )}
      </AppShell>
    )
  }

  const current: Book = book.data

  return (
    <AppShell>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/discover">Books</Link>
        <Icon name="chevron-right" size="0.85em" />
        <span aria-current="page">{current.title}</span>
      </nav>

      <article className="book-detail">
        <aside className="book-detail__aside">
          <BookCover book={current} size="xl" className="book-detail__cover" />

          {/* A catalogue title has sample chapters seeded, so it can be read
              here as well as shelved. Zero chapters means no way in, and the
              action hides rather than dead-ending. */}
          {current.chapterCount > 0 ? (
            <ButtonLink
              variant="primary"
              size="md"
              fullWidth
              to={`/read/${current.slug}/1`}
              startIcon={<Icon name="book-open" size="1em" />}
            >
              Read now
            </ButtonLink>
          ) : null}

          <ShelfMenu
            bookId={current.id}
            status={status}
            size="md"
            fullWidth
            onChange={setStatus}
          />

          {status === null ? (
            <p className="book-detail__hint">
              Saved books appear in <Link to="/library">your library</Link>.
            </p>
          ) : (
            <p className="book-detail__hint">
              On your <Link to="/library">{READING_STATUS_LABELS[status]}</Link> shelf.
            </p>
          )}
        </aside>

        <div className="book-detail__main">
          <p className="book-detail__eyebrow">
            {current.isCompleted ? 'Complete' : 'Still running'}
          </p>

          <h1 className="book-detail__title">{current.title}</h1>
          <p className="book-detail__author">{authorName(current.author)}</p>

          <div className="book-detail__meta">
            {current.ratingAverage === null ? (
              <span className="book-detail__dim">Not yet rated</span>
            ) : (
              <span className="book-detail__rating">
                <Stars value={current.ratingAverage} size="0.95em" />
                <strong>{formatRating(current.ratingAverage)}</strong>
              </span>
            )}
            <span className="book-detail__stat">
              <Icon name="eye" size="0.9em" />
              {formatCount(current.viewCount)} reads
            </span>
            <span className="book-detail__stat">
              <Icon name="heart" size="0.9em" />
              {formatCount(current.likeCount)}
            </span>
          </div>

          {current.genres.length > 0 ? (
            <div className="book-detail__genres">
              {current.genres.map((genre) => (
                <Link
                  key={genre.id}
                  className="chip chip--genre chip--sm"
                  style={genreChipStyle(genre.hue) as CSSProperties}
                  to={`/discover?genre=${genre.id}`}
                >
                  {genre.name}
                </Link>
              ))}
            </div>
          ) : null}

          {current.description ? (
            <div className="book-detail__blurb">
              <p>{current.description}</p>
            </div>
          ) : null}

          <section className="book-facts" aria-labelledby="book-facts-title">
            <h2 className="book-facts__title" id="book-facts-title">
              Publication
            </h2>
            <dl className="book-facts__list">
              <Fact label="Publisher" value={current.publisher} />
              <Fact
                label="Published"
                value={current.publishedAt ? formatDate(current.publishedAt) : null}
              />
              <Fact
                label="Pages"
                value={current.pageCount ? formatCount(current.pageCount) : null}
              />
              <Fact label="ISBN" value={current.isbn} />
            </dl>
            {!current.publisher &&
            !current.publishedAt &&
            !current.pageCount &&
            !current.isbn ? (
              <p className="book-facts__none">
                No publication details recorded for this book.
              </p>
            ) : null}
          </section>
        </div>
      </article>

      <section className="rail">
        <header className="rail__head">
          <h2 className="rail__title">Related books</h2>
          <p className="rail__desc">Others in the same genres.</p>
        </header>

        {related.status === 'loading' ? (
          <div className="rail__track" aria-busy="true">
            {Array.from({ length: 4 }, (_, index) => (
              <BookCardSkeleton key={index} />
            ))}
          </div>
        ) : related.status === 'error' ? (
          <ErrorState message={related.error} onRetry={related.reload} />
        ) : relatedBooks && relatedBooks.books.length > 0 ? (
          <div className="rail__track">
            {relatedBooks.books.map((item) => (
              <BookCard
                key={item.id}
                book={item}
                onShelfChange={(next) => setRelatedStatus(item.id, next)}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            size="sm"
            icon="book"
            title="Nothing related yet"
            description="There is nothing else in this book's genres so far."
          />
        )}
      </section>
    </AppShell>
  )
}
