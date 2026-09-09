import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAsync } from '../hooks/useAsync'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { formatCount, formatDate, formatRating } from '../lib/format'
import * as books from '../data/books-api'
import {
  BOOK_SORTS,
  BOOK_SORT_LABELS,
  authorName,
  type Book,
  type BookAvailability,
  type BookSort,
} from '../types/books'
import { AppShell } from '../components/layout/AppShell'
import { Button, ButtonLink } from '../components/ui/Button'
import { SelectableChip } from '../components/ui/Chip'
import { Icon } from '../components/ui/Icon'
import { Select } from '../components/ui/Select'
import { TextField } from '../components/ui/TextField'
import { Stars } from '../components/ui/Rating'
import { EmptyState, ErrorState } from '../components/ui/States'
import { BookCard, BookCardSkeleton } from '../components/books/BookCard'
import { BookCover } from '../components/books/BookCover'
import { ShelfMenu } from '../components/books/ShelfMenu'
import './pages.css'
import '../components/books/books.css'

const AVAILABILITY_OPTIONS: ReadonlyArray<{
  value: BookAvailability
  label: string
}> = [
  { value: 'all', label: 'Any length' },
  { value: 'completed', label: 'Complete' },
  { value: 'ongoing', label: 'Still running' },
]

const SORT_OPTIONS = BOOK_SORTS.map((sort) => ({
  value: sort,
  label: BOOK_SORT_LABELS[sort],
}))

const PAGE_SIZE = 12

function isSort(value: string | null): value is BookSort {
  return value !== null && (BOOK_SORTS as readonly string[]).includes(value)
}

function isAvailability(value: string | null): value is BookAvailability {
  return value === 'all' || value === 'completed' || value === 'ongoing'
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Legacy slugs that do not simply slugify to a catalogue genre's name. The
 * mock data this page used to read called science fiction "Sci-Fi".
 */
const LEGACY_GENRE_SLUGS: Record<string, string> = {
  'sci-fi': 'science-fiction',
}

/** "Historical Fiction" -> "historical-fiction", to match legacy genre links. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/* Featured -------------------------------------------------------------- */

function FeaturedBook({
  book,
  onShelfChange,
}: {
  book: Book
  onShelfChange: (status: Book['libraryStatus']) => void
}) {
  return (
    <section className="featured" aria-labelledby="featured-title">
      <Link className="featured__cover" to={`/book/${book.id}`} tabIndex={-1} aria-hidden="true">
        <BookCover book={book} size="xl" />
      </Link>

      <div className="featured__body">
        <p className="featured__eyebrow">Editor's pick</p>

        <h2 className="featured__title" id="featured-title">
          <Link to={`/book/${book.id}`}>{book.title}</Link>
        </h2>

        <p className="featured__author">{authorName(book.author)}</p>

        {book.description ? (
          <p className="featured__blurb">{book.description}</p>
        ) : null}

        <div className="featured__meta">
          {book.ratingAverage === null ? null : (
            <span className="featured__rating">
              <Stars value={book.ratingAverage} size="0.9em" />
              <strong>{formatRating(book.ratingAverage)}</strong>
            </span>
          )}
          {book.pageCount ? <span>{formatCount(book.pageCount)} pages</span> : null}
          {book.publishedAt ? <span>{formatDate(book.publishedAt)}</span> : null}
        </div>

        <div className="featured__actions">
          <ShelfMenu
            bookId={book.id}
            status={book.libraryStatus}
            size="md"
            onChange={onShelfChange}
          />
          <ButtonLink
            to={`/book/${book.id}`}
            variant="ghost"
            size="md"
            endIcon={<Icon name="arrow-right" size="1em" />}
          >
            Read more
          </ButtonLink>
        </div>
      </div>
    </section>
  )
}

/* Rails ----------------------------------------------------------------- */

function Rail({
  title,
  description,
  items,
  onShelfChange,
}: {
  title: string
  description?: string
  items: Book[]
  onShelfChange: (bookId: string, status: Book['libraryStatus']) => void
}) {
  if (items.length === 0) return null

  return (
    <section className="rail">
      <header className="rail__head">
        <h2 className="rail__title">{title}</h2>
        {description ? <p className="rail__desc">{description}</p> : null}
      </header>

      <div className="rail__track">
        {items.map((book) => (
          <BookCard
            key={book.id}
            book={book}
            onShelfChange={(status) => onShelfChange(book.id, status)}
          />
        ))}
      </div>
    </section>
  )
}

/* Page ------------------------------------------------------------------ */

export function DiscoverPage() {
  const [params, setParams] = useSearchParams()

  // Read once: these seed the initial state, and the effect below keeps the
  // URL in step from then on.
  const initialStatus = params.get('status')
  const initialSort = params.get('sort')

  const initialGenre = params.get('genre')

  const [search, setSearch] = useState(params.get('q') ?? '')
  const [genreId, setGenreId] = useState<string | null>(
    initialGenre && UUID.test(initialGenre) ? initialGenre : null,
  )
  /**
   * Genre chips elsewhere in the app link to `/discover?genre=<slug>`, from
   * back when this page read the mock data. Hold the slug until the genre list
   * arrives, then trade it for the real id — the URL sync below rewrites the
   * query string to the id, so the link canonicalises itself on arrival.
   */
  const [pendingGenre, setPendingGenre] = useState<string | null>(
    initialGenre && !UUID.test(initialGenre) ? initialGenre.toLowerCase() : null,
  )
  const [availability, setAvailability] = useState<BookAvailability>(
    isAvailability(initialStatus) ? initialStatus : 'all',
  )
  const [sort, setSort] = useState<BookSort>(
    isSort(initialSort) ? initialSort : 'trending',
  )

  const debouncedSearch = useDebouncedValue(search, 280)
  const genres = useAsync(() => books.getGenres(), [])

  if (pendingGenre !== null && genres.status !== 'loading') {
    const wanted = LEGACY_GENRE_SLUGS[pendingGenre] ?? pendingGenre
    const match = genres.data?.find((genre) => slugify(genre.name) === wanted)
    setPendingGenre(null)
    if (match) setGenreId(match.id)
  }

  // Browsing is the rail-led editorial view; the moment a reader narrows
  // anything, the page becomes a straightforward result grid.
  const isBrowsing =
    debouncedSearch.trim() === '' &&
    genreId === null &&
    pendingGenre === null &&
    availability === 'all'

  const discover = useAsync(
    () => (isBrowsing ? books.getDiscover() : Promise.resolve(null)),
    [isBrowsing],
  )

  useEffect(() => {
    const next = new URLSearchParams()
    if (debouncedSearch.trim()) next.set('q', debouncedSearch.trim())
    if (genreId) next.set('genre', genreId)
    if (availability !== 'all') next.set('status', availability)
    if (!isBrowsing) next.set('sort', sort)
    setParams(next, { replace: true })
  }, [debouncedSearch, genreId, availability, sort, isBrowsing, setParams])

  /* Paginated results, accumulated across "Load more". ------------------ */

  const filterKey = JSON.stringify({ debouncedSearch, genreId, availability, sort })
  const [query, setQuery] = useState({ key: filterKey, page: 1 })
  const [results, setResults] = useState<Book[]>([])
  const [resultMeta, setResultMeta] = useState<{ total: number; hasMore: boolean } | null>(
    null,
  )
  const [listStatus, setListStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [listError, setListError] = useState<string | null>(null)

  // Reset to the first page during render when the filters change, so a
  // superseded page can never be appended to a fresh result set.
  if (query.key !== filterKey) {
    setQuery({ key: filterKey, page: 1 })
    setResults([])
    setResultMeta(null)
    setListStatus('loading')
    setListError(null)
  }

  useEffect(() => {
    if (isBrowsing) return

    let active = true

    books
      .listBooks({
        search: debouncedSearch,
        genreId,
        status: availability,
        sort,
        page: query.page,
        limit: PAGE_SIZE,
      })
      .then((page) => {
        if (!active) return
        setResults((current) =>
          query.page === 1 ? page.items : [...current, ...page.items],
        )
        setResultMeta({ total: page.total, hasMore: page.hasMore })
        setListStatus('ready')
        setListError(null)
      })
      .catch((cause: unknown) => {
        if (!active) return
        setListStatus('error')
        setListError(
          cause instanceof Error ? cause.message : 'Those books did not load.',
        )
      })

    return () => {
      active = false
    }
    // `query` carries both the filter identity and the page number.
  }, [query, isBrowsing, debouncedSearch, genreId, availability, sort])

  /* Keeping shelf changes visible wherever the book appears ------------- */

  function applyShelfChange(bookId: string, status: Book['libraryStatus']): void {
    setResults((current) =>
      current.map((book) =>
        book.id === bookId ? { ...book, libraryStatus: status } : book,
      ),
    )
    // The rails come from a cached response; reloading keeps them honest.
    if (isBrowsing) discover.reload()
  }

  function clearFilters(): void {
    setSearch('')
    setGenreId(null)
    setAvailability('all')
  }

  return (
    <AppShell>
      <header className="page-head">
        <div>
          <h1 className="page-head__title">Discover</h1>
          <p className="page-head__sub">
            Browse the shelves, follow a genre, and keep what you find.
          </p>
        </div>
      </header>

      <div className="filters">
        <div className="filters__row">
          <TextField
            label="Search books"
            hideLabel
            placeholder="Search by title or author…"
            value={search}
            startIcon={<Icon name="search" size="1em" />}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Select
            label="Sort"
            hideLabel
            value={sort}
            options={SORT_OPTIONS}
            onChange={setSort}
          />
          <Select
            label="Availability"
            hideLabel
            value={availability}
            options={AVAILABILITY_OPTIONS}
            onChange={setAvailability}
          />
        </div>

        {genres.status === 'ready' && genres.data ? (
          <div className="filters__panel">
            <span className="filters__label">Genres</span>
            <div className="filters__group--inline">
              {genres.data
                .filter((genre) => genre.bookCount > 0)
                .map((genre) => (
                  <SelectableChip
                    key={genre.id}
                    hue={genre.hue}
                    selected={genreId === genre.id}
                    onToggle={() =>
                      setGenreId((current) => (current === genre.id ? null : genre.id))
                    }
                  >
                    {genre.name}
                  </SelectableChip>
                ))}
            </div>
          </div>
        ) : null}
      </div>

      {isBrowsing ? (
        discover.status === 'loading' ? (
          <div className="book-grid" aria-busy="true">
            {Array.from({ length: 8 }, (_, index) => (
              <BookCardSkeleton key={index} />
            ))}
          </div>
        ) : discover.status === 'error' ? (
          <ErrorState message={discover.error} onRetry={discover.reload} />
        ) : discover.data ? (
          <>
            {discover.data.featured ? (
              <FeaturedBook
                book={discover.data.featured}
                onShelfChange={(status) =>
                  applyShelfChange(discover.data!.featured!.id, status)
                }
              />
            ) : null}

            <Rail
              title="Trending now"
              description="What people are opening this week."
              items={discover.data.trending}
              onShelfChange={applyShelfChange}
            />
            <Rail
              title="Highly rated"
              description="The books readers finish and then recommend."
              items={discover.data.recommended}
              onShelfChange={applyShelfChange}
            />

            {discover.data.sections.map((section) => (
              <Rail
                key={section.genre.id}
                title={section.genre.name}
                items={section.books}
                onShelfChange={applyShelfChange}
              />
            ))}

            {discover.data.featured === null &&
            discover.data.trending.length === 0 ? (
              <EmptyState
                icon="book"
                title="No books yet"
                description="Seed the catalogue with `pnpm --filter api seed:books` to fill these shelves."
              />
            ) : null}
          </>
        ) : null
      ) : (
        <section className="results">
          <p className="results__count" role="status">
            {listStatus === 'loading' && results.length === 0
              ? 'Searching…'
              : resultMeta
                ? `${formatCount(resultMeta.total)} ${resultMeta.total === 1 ? 'book' : 'books'}`
                : ''}
          </p>

          {listStatus === 'error' ? (
            <ErrorState
              message={listError}
              onRetry={() => {
                setListStatus('loading')
                setQuery((current) => ({ ...current }))
              }}
            />
          ) : listStatus === 'loading' && results.length === 0 ? (
            <div className="book-grid" aria-busy="true">
              {Array.from({ length: 8 }, (_, index) => (
                <BookCardSkeleton key={index} />
              ))}
            </div>
          ) : results.length === 0 ? (
            <EmptyState
              icon="search"
              title="Nothing matched"
              description="Try a different title, author or genre."
              action={
                <Button variant="secondary" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <>
              <div className="book-grid">
                {results.map((book) => (
                  <BookCard
                    key={book.id}
                    book={book}
                    onShelfChange={(status) => applyShelfChange(book.id, status)}
                  />
                ))}
              </div>

              {resultMeta?.hasMore ? (
                <div className="results__more">
                  <Button
                    variant="secondary"
                    loading={listStatus === 'loading'}
                    onClick={() => {
                      setListStatus('loading')
                      setQuery((current) => ({ ...current, page: current.page + 1 }))
                    }}
                  >
                    Load more
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </section>
      )}
    </AppShell>
  )
}
