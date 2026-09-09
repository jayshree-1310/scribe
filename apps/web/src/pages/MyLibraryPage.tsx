import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAsync } from '../hooks/useAsync'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { formatRelative } from '../lib/format'
import * as books from '../data/books-api'
import {
  READING_STATUSES,
  READING_STATUS_LABELS,
  authorName,
  type LibraryEntry,
  type ReadingStatus,
} from '../types/books'
import { AppShell } from '../components/layout/AppShell'
import { Button, ButtonLink } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { TextField } from '../components/ui/TextField'
import { Tabs } from '../components/ui/Tabs'
import { EmptyState, ErrorState } from '../components/ui/States'
import { BookCardSkeleton } from '../components/books/BookCard'
import { BookCover } from '../components/books/BookCover'
import { ShelfMenu } from '../components/books/ShelfMenu'
import './pages.css'
import '../components/books/books.css'

const EMPTY_COPY: Record<ReadingStatus, { title: string; description: string }> = {
  WANT_TO_READ: {
    title: 'Nothing on the list yet',
    description:
      'Books you mean to get to land here. Add one and it will be waiting.',
  },
  READING: {
    title: 'Nothing in progress',
    description: 'Move a book here when you start it, and pick it up any time.',
  },
  FINISHED: {
    title: 'Nothing finished yet',
    description: 'Everything you read to the end collects here.',
  },
}

/**
 * One book on a shelf.
 *
 * Deliberately not the catalogue card: this is a reader's own copy, so it
 * leads with when they shelved it and puts the shelf control beside it, rather
 * than repeating discovery statistics they no longer need.
 */
function ShelfItem({
  entry,
  onChange,
}: {
  entry: LibraryEntry
  onChange: (status: ReadingStatus | null) => void
}) {
  const { book } = entry

  return (
    <article className="shelf-item">
      <Link
        className="shelf-item__cover"
        to={`/book/${book.id}`}
        tabIndex={-1}
        aria-hidden="true"
      >
        <BookCover book={book} size="sm" />
      </Link>

      <div className="shelf-item__body">
        <h3 className="shelf-item__title">
          <Link to={`/book/${book.id}`}>{book.title}</Link>
        </h3>
        <p className="shelf-item__author">{authorName(book.author)}</p>

        <p className="shelf-item__added">
          {book.genres[0] ? `${book.genres[0].name} · ` : ''}
          Added {formatRelative(entry.addedAt)}
        </p>
      </div>

      <div className="shelf-item__actions">
        <ShelfMenu bookId={book.id} status={entry.status} onChange={onChange} />
      </div>
    </article>
  )
}

export function MyLibraryPage() {
  const [shelf, setShelf] = useState<ReadingStatus>('READING')
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search, 260)

  const library = useAsync(
    () => books.getLibrary({ status: shelf, search: debouncedSearch }),
    [shelf, debouncedSearch],
  )

  const counts = library.data?.counts
  const items = library.data?.items ?? []
  const searching = debouncedSearch.trim().length > 0

  const tabs = READING_STATUSES.map((status) => ({
    id: status,
    label: READING_STATUS_LABELS[status],
    count: counts?.[status],
  }))

  return (
    <AppShell>
      <header className="page-head">
        <div>
          <h1 className="page-head__title">My library</h1>
          <p className="page-head__sub">
            Everything you mean to read, everything you're reading, and
            everything you've finished.
          </p>
        </div>
        <ButtonLink to="/books" startIcon={<Icon name="plus" size="1em" />}>
          Find books
        </ButtonLink>
      </header>

      <Tabs items={tabs} active={shelf} onChange={setShelf} label="Reading shelves" />

      <div className="filters">
        <div className="filters__row">
          <TextField
            label="Search your library"
            hideLabel
            placeholder="Search your library…"
            value={search}
            startIcon={<Icon name="search" size="1em" />}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>

      {library.status === 'loading' ? (
        <div className="shelf-list" aria-busy="true">
          {Array.from({ length: 4 }, (_, index) => (
            <BookCardSkeleton key={index} variant="row" />
          ))}
        </div>
      ) : library.status === 'error' ? (
        <ErrorState message={library.error} onRetry={library.reload} />
      ) : items.length === 0 ? (
        searching ? (
          <EmptyState
            icon="search"
            title="Nothing here matches"
            description={`No book on your ${READING_STATUS_LABELS[shelf].toLowerCase()} shelf matches “${debouncedSearch.trim()}”.`}
            action={
              <Button variant="secondary" onClick={() => setSearch('')}>
                Clear search
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon="library"
            title={EMPTY_COPY[shelf].title}
            description={EMPTY_COPY[shelf].description}
            action={<ButtonLink to="/books">Browse books</ButtonLink>}
          />
        )
      ) : (
        <div className="shelf-list">
          {items.map((entry) => (
            <ShelfItem
              key={entry.id}
              entry={entry}
              // Moving a book off this shelf — or removing it — changes what
              // belongs here and every tab count, so reload rather than patch.
              onChange={() => library.reload()}
            />
          ))}
        </div>
      )}
    </AppShell>
  )
}
