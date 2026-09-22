import { useState } from 'react'
import { useAsync } from '../hooks/useAsync'
import { useAuth } from '../lib/auth'
import { formatCount } from '../lib/format'
import * as books from '../data/books-api'
import * as challengesApi from '../data/challenges-api'
import * as clubsApi from '../data/clubs-api'
import { getBadges } from '../data/gamification-api'
import * as reading from '../data/reading-api'
import * as recommendationsApi from '../data/recommendations-api'
import type { Book, Discover } from '../types/books'
import { ButtonLink } from '../components/ui/Button'
import { SectionHead } from '../components/ui/Card'
import { Icon } from '../components/ui/Icon'
import { EmptyState, ErrorState } from '../components/ui/States'
import { ProgressBar } from '../components/ui/Progress'
import { Skeleton } from '../components/ui/Skeleton'
import { BookCard, BookCardSkeleton } from '../components/books/BookCard'
import { StoryCard, StoryCardSkeleton } from '../components/story/StoryCard'
import { StoryShelf } from '../components/story/StoryShelf'
import { ContinueCard } from '../components/story/ContinueCard'
import { ChallengeCard, ClubCard } from '../components/story/Cards'
import './pages.css'
import '../components/books/books.css'

export function HomePage() {
  const { session } = useAuth()

  const discover = useAsync(() => books.getDiscover(), [])
  const shelved = useAsync(() => books.getLibrary({ status: 'READING' }), [])
  /**
   * Where the reader actually left off, which is not the same question as the
   * Reading shelf below: this comes from reading activity and carries a resume
   * target, that one is the set of books they chose to shelve.
   */
  const inProgressStories = useAsync(() => reading.getContinueReading(4), [])
  /**
   * The personalised rail, ranked server-side from this reader's genres,
   * shelves, reading history, ratings and follows. It answers trending when
   * they have given it nothing to rank on, and says which of the two it did
   * in `basis` -- so the shelf below can be worded honestly rather than
   * promising personalisation to somebody who just signed up.
   */
  const recommended = useAsync(() => recommendationsApi.getRecommendations(12), [])
  const clubs = useAsync(() => clubsApi.listClubs({ limit: 6 }), [])
  const challenges = useAsync(() => challengesApi.getChallenges(), [])
  /**
   * The header's reading numbers, from the same response `/badges` answers.
   *
   * They used to come off the session, which carried a fixed `chaptersRead`
   * and a `minutesReadThisWeek` from the mock profile -- the same two numbers
   * for every account on the platform. `levels.reader` is the honest version
   * of the first: it *is* chapters read, counted from reading history, and it
   * carries the next level's threshold, so the meter has a real goal to fill.
   *
   * There is no honest version of the second. Nothing records how long anybody
   * reads for -- no duration is stored anywhere -- so the weekly-minutes goal
   * went rather than being computed from something that only looked like it.
   */
  const progress = useAsync(() => getBadges(), [])

  /**
   * A local copy of the rails, so shelving a book updates its card straight
   * away instead of waiting for a refetch. `source` records which response the
   * copy came from, so a fresh load replaces it while edits survive renders.
   */
  const [rails, setRails] = useState<{
    source: Discover
    trending: Book[]
  } | null>(null)

  if (discover.status === 'ready' && discover.data && rails?.source !== discover.data) {
    setRails({ source: discover.data, trending: discover.data.trending })
  }

  /** Reflects a shelf change on every rail the book appears in. */
  function applyShelfChange(bookId: string, status: Book['libraryStatus']): void {
    const update = (list: Book[]) =>
      list.map((book) => (book.id === bookId ? { ...book, libraryStatus: status } : book))

    setRails((current) =>
      current === null ? current : { ...current, trending: update(current.trending) },
    )

    // The "currently reading" shelf is defined by status, so it has to reload.
    shelved.reload()
  }

  const user = session?.user
  // Nullable on the account endpoint: a Google signup has no display name
  // until they set one, and a password signup only has the handle.
  const firstName = (user?.displayName || user?.username)?.split(' ')[0] ?? 'there'
  const streak = user?.readingStreak ?? 0
  const readerLevel = progress.data?.levels.reader ?? null

  const inProgress = shelved.data?.items ?? []
  /**
   * A failed continue list is not surfaced: the rail simply does not appear.
   * It is a shortcut back into something the reader can still reach from their
   * library, and an error panel above the fold for it would cost more than it
   * tells them.
   */
  const resumable = inProgressStories.data ?? []
  const myClubs = clubs.data?.items.filter((club) => club.membership !== null) ?? []
  const suggestedClubs =
    clubs.data?.items.filter((club) => club.membership === null) ?? []
  const activeChallenges = challenges.data?.active ?? []
  const picks = recommended.data?.items ?? []
  /** False on the cold-start path, which is trending rather than personal. */
  const personalised = recommended.data?.basis === 'personal'

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
    <>
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
            {readerLevel ? (
              `${formatCount(readerLevel.value)} chapters read all-time`
            ) : progress.status === 'error' ? (
              /*
                No retry and no panel: the streak beside it is already right,
                it came from the session. A failed count is one clause missing
                from a greeting, and an error box at the top of the home page
                would be louder than what it is reporting.
              */
              'Chapters read is unavailable right now.'
            ) : (
              <Skeleton width="11rem" />
            )}
          </p>
        </div>
        {/*
          The meter is a reader level rather than a weekly goal. Chapters read
          is counted; minutes read is not recorded anywhere, so the old
          "284 / 400 minutes" was the mock's number shown to everybody. Hidden
          rather than skeletoned while it loads: the tile reads as complete
          without it, and a placeholder bar that fills in a moment later draws
          more attention than the number deserves.
        */}
        {readerLevel ? (
          <div className="streak__goal">
            <div className="streak__goal-head">
              <span>Reader level {readerLevel.level}</span>
              <strong>
                {readerLevel.next === null
                  ? 'Top level'
                  : `${formatCount(readerLevel.value)} / ${formatCount(readerLevel.next)} chapters`}
              </strong>
            </div>
            <ProgressBar
              value={readerLevel.progress}
              size="md"
              label={
                readerLevel.next === null
                  ? 'Reader level: top of the ladder'
                  : `Progress toward reader level ${readerLevel.level + 1}`
              }
            />
          </div>
        ) : null}
      </section>

      {/* Pick up where you left off -------------------------------------- */}
      {/*
        Rendered only when there is something to resume. A reader who has not
        started anything already has the Reading shelf's empty state below,
        and two empty states stacked would say the same thing twice.
      */}
      {resumable.length > 0 || inProgressStories.status === 'loading' ? (
        <section className="page-section">
          <SectionHead
            title="Pick up where you left off"
            subtitle="The last thing you were reading, at the page you stopped on."
          />

          {inProgressStories.status === 'loading' ? (
            <div className="card-grid card-grid--wide">
              {Array.from({ length: 2 }, (_, index) => (
                <Skeleton key={index} height="7.5rem" radius="var(--radius-lg)" />
              ))}
            </div>
          ) : (
            <div className="card-grid card-grid--wide">
              {resumable.map((entry) => (
                <ContinueCard key={entry.story.id} entry={entry} />
              ))}
            </div>
          )}
        </section>
      ) : null}

      {/* Currently reading ---------------------------------------------- */}
      <section className="page-section">
        <SectionHead title="Currently reading" to="/library" linkLabel="My library" />

        {shelved.status === 'error' ? (
          <ErrorState message={shelved.error} onRetry={shelved.reload} />
        ) : shelved.status === 'loading' ? (
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
                onShelfChange={() => shelved.reload()}
              />
            ))}
          </div>
        )}
      </section>

      {/* Recommended ----------------------------------------------------- */}
      <section className="page-section">
        <SectionHead
          title={personalised ? 'Recommended for you' : 'Trending on Scribe'}
          subtitle={
            personalised
              ? 'Ranked from the genres you picked, your shelves and what you have been reading.'
              : 'Tell us what you like in Settings and this shelf becomes yours.'
          }
          to="/discover"
        />

        {recommended.status === 'error' ? (
          <ErrorState message={recommended.error} onRetry={recommended.reload} />
        ) : recommended.status === 'ready' && picks.length === 0 ? (
          /*
            Only reachable once a reader has met everything listed on Scribe,
            since the cold-start path answers trending rather than nothing. The
            catalogue rails below are still worth pointing at.
          */
          <EmptyState
            icon="compass"
            size="sm"
            title="Nothing new to suggest"
            description="You have already met every story on Scribe. The catalogue below is a good place to go next."
          />
        ) : (
          <StoryShelf label="Recommended stories">
            {recommended.status === 'loading'
              ? Array.from({ length: 6 }, (_, index) => (
                  <li key={index}>
                    <StoryCardSkeleton />
                  </li>
                ))
              : picks.map((item) => (
                  <li key={item.story.id}>
                    <StoryCard story={item.story} />
                    <p className="shelf__reason">{item.reason}</p>
                  </li>
                ))}
          </StoryShelf>
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
        ) : rails !== null && rails.trending.length === 0 ? (
          /*
            An empty rail is not nothing: the shelf collapses to no height and
            leaves its scroll arrows stranded against the heading. Say there is
            nothing to show instead.
          */
          <EmptyState
            icon="compass"
            size="sm"
            title="No trending books yet"
            description="Nothing has been read widely enough this week. Browse the full catalogue instead."
            action={
              <ButtonLink variant="secondary" to="/discover">
                Browse books
              </ButtonLink>
            }
          />
        ) : (
          rail('Trending books', rails?.trending)
        )}
      </section>

      {/* Clubs and challenges -------------------------------------------
        Both of these read their status before their data. Under the mock they
        could not: a request that always resolved meant an empty list only ever
        meant "there are none", so `length === 0` was a safe test. Against the
        API it is also what a failed request and an in-flight one look like,
        and both were telling the reader there are no clubs and no challenges
        running — the second of which they would have had no reason to doubt.
      */}
      <div className="two-col">
        <section className="page-section">
          <SectionHead title="Your book clubs" to="/clubs" linkLabel="All clubs" />
          {clubs.status === 'error' ? (
            <ErrorState message={clubs.error} onRetry={clubs.reload} />
          ) : clubs.status === 'loading' ? (
            <div className="row-list">
              {Array.from({ length: 2 }, (_, index) => (
                <Skeleton key={index} height="5.5rem" radius="var(--radius-lg)" />
              ))}
            </div>
          ) : myClubs.length === 0 && suggestedClubs.length === 0 ? (
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
          {challenges.status === 'error' ? (
            <ErrorState message={challenges.error} onRetry={challenges.reload} />
          ) : challenges.status === 'loading' ? (
            <div className="row-list">
              {Array.from({ length: 2 }, (_, index) => (
                <Skeleton key={index} height="5.5rem" radius="var(--radius-lg)" />
              ))}
            </div>
          ) : activeChallenges.length === 0 ? (
            <EmptyState icon="trophy" size="sm" title="Nothing running right now" />
          ) : (
            <div className="row-list">
              {activeChallenges.slice(0, 2).map((challenge) => (
                <ChallengeCard key={challenge.id} challenge={challenge} />
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  )
}
