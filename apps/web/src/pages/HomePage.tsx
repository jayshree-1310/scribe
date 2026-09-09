import { useState } from 'react'
import { useAsync } from '../hooks/useAsync'
import { useAuth } from '../lib/auth'
import { formatCount, formatMinutes } from '../lib/format'
import * as api from '../data/api'
import * as books from '../data/books-api'
import type { Book, Discover } from '../types/books'
import { AppShell } from '../components/layout/AppShell'
import { ButtonLink } from '../components/ui/Button'
import { SectionHead } from '../components/ui/Card'
import { Icon } from '../components/ui/Icon'
import { EmptyState, ErrorState } from '../components/ui/States'
import { ProgressBar } from '../components/ui/Progress'
import { BookCard, BookCardSkeleton } from '../components/books/BookCard'
import { StoryShelf } from '../components/story/StoryShelf'
import { ChallengeCard, ClubCard } from '../components/story/Cards'
import './pages.css'
import '../components/books/books.css'

const WEEKLY_GOAL_MINUTES = 400

export function HomePage() {
  const { session } = useAuth()

  // Books come from the catalogue API; clubs and challenges are still the
  // mock data layer, which is a separate feature from the book shelves.
  const discover = useAsync(() => books.getDiscover(), [])
  const reading = useAsync(() => books.getLibrary({ status: 'READING' }), [])
  const clubs = useAsync(() => api.getClubs(), [])
  const challenges = useAsync(() => api.getChallenges(), [])

  /**
   * A local copy of the rails, so shelving a book updates its card straight
   * away instead of waiting for a refetch. `source` records which response the
   * copy came from, so a fresh load replaces it while edits survive renders.
   */
  const [rails, setRails] = useState<{
    source: Discover
    trending: Book[]
    recommended: Book[]
  } | null>(null)

  if (discover.status === 'ready' && discover.data && rails?.source !== discover.data) {
    setRails({
      source: discover.data,
      trending: discover.data.trending,
      recommended: discover.data.recommended,
    })
  }

  /** Reflects a shelf change on every rail the book appears in. */
  function applyShelfChange(bookId: string, status: Book['libraryStatus']): void {
    const update = (list: Book[]) =>
      list.map((book) => (book.id === bookId ? { ...book, libraryStatus: status } : book))

    setRails((current) =>
      current === null
        ? current
        : {
            ...current,
            trending: update(current.trending),
            recommended: update(current.recommended),
          },
    )

    // The "currently reading" shelf is defined by status, so it has to reload.
    reading.reload()
  }

  const user = session?.user
  const firstName = user?.displayName.split(' ')[0] ?? 'there'
  const streak = user?.stats.readingStreakDays ?? 0
  const minutes = user?.stats.minutesReadThisWeek ?? 0

  const inProgress = reading.data?.items ?? []
  const myClubs = clubs.data?.filter((club) => club.membership !== null) ?? []
  const suggestedClubs = clubs.data?.filter((club) => club.membership === null) ?? []
  const activeChallenges = challenges.data?.filter((item) => item.state === 'active') ?? []

  /** Rail body: skeletons while loading, cards once there are any. */
  function rail(label: string, items: Book[] | undefined) {
    return (
      <StoryShelf label={label}>
        {items === undefined
          ? Array.from({ length: 6 }, (_, index) => (
              <li key={index}>
                <BookCardSkeleton />
              </li>
            ))
          : items.map((book) => (
              <li key={book.id}>
                <BookCard
                  book={book}
                  onShelfChange={(status) => applyShelfChange(book.id, status)}
                />
              </li>
            ))}
      </StoryShelf>
    )
  }

  return (
    <AppShell>
      {/* Greeting + streak ---------------------------------------------- */}
      <header className="page-head">
        <div>
          <h1 className="page-head__title">Good to see you, {firstName}.</h1>
          <p className="page-head__sub">
            {inProgress.length
              ? `You have ${inProgress.length} ${inProgress.length === 1 ? 'book' : 'books'} on the go.`
              : 'Nothing in progress — a good moment to start something.'}
          </p>
        </div>
        <ButtonLink to="/discover" variant="secondary" startIcon={<Icon name="compass" size="1em" />}>
          Discover books
        </ButtonLink>
      </header>

      <section className="streak">
        <div className="streak__flame">
          <Icon name="flame" size="1.5rem" />
        </div>
        <div className="streak__body">
          <p className="streak__headline">
            {streak} day reading streak
            <span className="streak__spark" aria-hidden="true">
              🔥
            </span>
          </p>
          <p className="streak__detail">
            {formatMinutes(minutes)} read this week ·{' '}
            {formatCount(user?.stats.chaptersRead ?? 0)} chapters all-time
          </p>
        </div>
        <div className="streak__goal">
          <div className="streak__goal-head">
            <span>Weekly goal</span>
            <strong>
              {formatMinutes(minutes)} / {formatMinutes(WEEKLY_GOAL_MINUTES)}
            </strong>
          </div>
          <ProgressBar
            value={minutes / WEEKLY_GOAL_MINUTES}
            size="md"
            label="Progress toward your weekly reading goal"
          />
        </div>
      </section>

      {/* Currently reading ---------------------------------------------- */}
      <section className="page-section">
        <SectionHead title="Currently reading" to="/library" linkLabel="My library" />

        {reading.status === 'error' ? (
          <ErrorState message={reading.error} onRetry={reading.reload} />
        ) : reading.status === 'loading' ? (
          <div className="card-grid card-grid--wide">
            {Array.from({ length: 2 }, (_, index) => (
              <BookCardSkeleton key={index} variant="row" />
            ))}
          </div>
        ) : inProgress.length === 0 ? (
          <EmptyState
            icon="book-open"
            size="sm"
            title="No books in progress"
            description="Move a book to your Reading shelf and it will be waiting here."
            action={
              <ButtonLink variant="primary" to="/discover">
                Find a book
              </ButtonLink>
            }
          />
        ) : (
          <div className="card-grid card-grid--wide">
            {inProgress.slice(0, 4).map((entry) => (
              <BookCard
                key={entry.id}
                book={entry.book}
                variant="row"
                onShelfChange={() => reading.reload()}
              />
            ))}
          </div>
        )}
      </section>

      {/* Highly rated ---------------------------------------------------- */}
      <section className="page-section">
        <SectionHead
          title="Highly rated"
          subtitle="The books readers finish and then recommend."
          to="/discover?sort=top-rated"
        />
        {discover.status === 'error' ? (
          <ErrorState message={discover.error} onRetry={discover.reload} />
        ) : (
          rail('Highly rated books', rails?.recommended)
        )}
      </section>

      {/* Trending -------------------------------------------------------- */}
      <section className="page-section">
        <SectionHead
          title="Trending books"
          subtitle="Most read across Scribe this week."
          to="/discover?sort=trending"
        />
        {discover.status === 'error' ? (
          <ErrorState message={discover.error} onRetry={discover.reload} />
        ) : (
          rail('Trending books', rails?.trending)
        )}
      </section>

      {/* Clubs and challenges ------------------------------------------- */}
      <div className="two-col">
        <section className="page-section">
          <SectionHead title="Your book clubs" to="/clubs" linkLabel="All clubs" />
          {myClubs.length === 0 && suggestedClubs.length === 0 ? (
            <EmptyState icon="users" size="sm" title="No clubs yet" />
          ) : (
            <div className="row-list">
              {(myClubs.length > 0 ? myClubs : suggestedClubs).slice(0, 2).map((club) => (
                <ClubCard key={club.id} club={club} />
              ))}
            </div>
          )}
        </section>

        <section className="page-section">
          <SectionHead title="Writing challenges" to="/challenges" linkLabel="All challenges" />
          <div className="row-list">
            {activeChallenges.slice(0, 2).map((challenge) => (
              <ChallengeCard key={challenge.id} challenge={challenge} />
            ))}
          </div>
        </section>
      </div>
    </AppShell>
  )
}
