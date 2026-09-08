import { useAsync } from '../hooks/useAsync'
import { useAuth } from '../lib/auth'
import { formatCount, formatMinutes } from '../lib/format'
import * as api from '../data/api'
import { AppShell } from '../components/layout/AppShell'
import { ButtonLink } from '../components/ui/Button'
import { SectionHead } from '../components/ui/Card'
import { Icon } from '../components/ui/Icon'
import { EmptyState, ErrorState } from '../components/ui/States'
import { ProgressBar } from '../components/ui/Progress'
import { ContinueCard } from '../components/story/ContinueCard'
import { StoryCard, StoryCardSkeleton } from '../components/story/StoryCard'
import { StoryShelf } from '../components/story/StoryShelf'
import { ChallengeCard, ClubCard } from '../components/story/Cards'
import './pages.css'

const WEEKLY_GOAL_MINUTES = 400

export function HomePage() {
  const { session } = useAuth()
  const favourites = session?.favoriteGenreIds ?? []

  const continuing = useAsync(() => api.getContinueReading(4), [])
  const recommended = useAsync(() => api.getRecommendedStories(favourites, 10), [favourites.join(',')])
  const trending = useAsync(() => api.getTrendingStories(10), [])
  const clubs = useAsync(() => api.getClubs(), [])
  const challenges = useAsync(() => api.getChallenges(), [])

  const user = session?.user
  const firstName = user?.displayName.split(' ')[0] ?? 'there'
  const streak = user?.stats.readingStreakDays ?? 0
  const minutes = user?.stats.minutesReadThisWeek ?? 0

  const myClubs = clubs.data?.filter((club) => club.membership !== null) ?? []
  const suggestedClubs = clubs.data?.filter((club) => club.membership === null) ?? []
  const activeChallenges = challenges.data?.filter((item) => item.state === 'active') ?? []

  return (
    <AppShell>
      {/* Greeting + streak ---------------------------------------------- */}
      <header className="page-head">
        <div>
          <h1 className="page-head__title">Good to see you, {firstName}.</h1>
          <p className="page-head__sub">
            {continuing.data?.length
              ? `You have ${continuing.data.length} ${continuing.data.length === 1 ? 'story' : 'stories'} on the go.`
              : 'Nothing in progress — a good moment to start something.'}
          </p>
        </div>
        <ButtonLink to="/discover" variant="secondary" startIcon={<Icon name="compass" size="1em" />}>
          Discover stories
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

      {/* Continue reading ----------------------------------------------- */}
      <section className="page-section">
        <SectionHead title="Continue reading" to="/library" linkLabel="My library" />

        {continuing.status === 'error' ? (
          <ErrorState message={continuing.error} onRetry={continuing.reload} />
        ) : continuing.status === 'loading' ? (
          <div className="card-grid card-grid--wide">
            {Array.from({ length: 2 }, (_, index) => (
              <div className="card card--padded" key={index}>
                <StoryCardSkeleton variant="row" />
              </div>
            ))}
          </div>
        ) : continuing.data?.length === 0 ? (
          <EmptyState
            icon="book-open"
            size="sm"
            title="No stories in progress"
            description="Start one and it will appear here with your place saved."
            action={
              <ButtonLink variant="primary" to="/discover">
                Find a story
              </ButtonLink>
            }
          />
        ) : (
          <div className="card-grid card-grid--wide">
            {continuing.data?.map((entry) => (
              <ContinueCard key={entry.history.id} entry={entry} />
            ))}
          </div>
        )}
      </section>

      {/* Recommended ---------------------------------------------------- */}
      <section className="page-section">
        <SectionHead
          title="Recommended for you"
          subtitle="Based on the genres you follow."
          to="/discover?sort=recommended"
        />
        {recommended.status === 'error' ? (
          <ErrorState message={recommended.error} onRetry={recommended.reload} />
        ) : (
          <StoryShelf label="Recommended stories">
            {recommended.status === 'loading'
              ? Array.from({ length: 6 }, (_, index) => (
                  <li key={index}>
                    <StoryCardSkeleton />
                  </li>
                ))
              : recommended.data?.map((story) => (
                  <li key={story.id}>
                    <StoryCard story={story} />
                  </li>
                ))}
          </StoryShelf>
        )}
      </section>

      {/* Trending ------------------------------------------------------- */}
      <section className="page-section">
        <SectionHead
          title="Trending stories"
          subtitle="Most read across Scribe this week."
          to="/discover?sort=trending"
        />
        {trending.status === 'error' ? (
          <ErrorState message={trending.error} onRetry={trending.reload} />
        ) : (
          <StoryShelf label="Trending stories">
            {trending.status === 'loading'
              ? Array.from({ length: 6 }, (_, index) => (
                  <li key={index}>
                    <StoryCardSkeleton />
                  </li>
                ))
              : trending.data?.map((story, index) => (
                  <li key={story.id}>
                    <StoryCard story={story} rank={index + 1} />
                  </li>
                ))}
          </StoryShelf>
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
