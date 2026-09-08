import { Link } from 'react-router-dom'
import { useAsync } from '../hooks/useAsync'
import { useAuth } from '../lib/auth'
import { formatCount } from '../lib/format'
import * as api from '../data/api'
import { PublicShell } from '../components/layout/PublicShell'
import { ButtonLink } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { SectionHead } from '../components/ui/Card'
import { ErrorState } from '../components/ui/States'
import { StoryCard, StoryCardSkeleton } from '../components/story/StoryCard'
import { StoryCover } from '../components/story/StoryCover'
import { StoryShelf } from '../components/story/StoryShelf'
import { ContinueCard } from '../components/story/ContinueCard'
import { AuthorCard, ChallengeCard, ClubCard, GenreCard } from '../components/story/Cards'
import './landing.css'

export function LandingPage() {
  const { session } = useAuth()

  const trending = useAsync(() => api.getTrendingStories(10), [])
  const genres = useAsync(() => api.getGenres(), [])
  const authors = useAsync(() => api.getAuthors(), [])
  const challenges = useAsync(() => api.getChallenges(), [])
  const clubs = useAsync(() => api.getClubs(), [])
  const continuing = useAsync(
    () => (session ? api.getContinueReading(3) : Promise.resolve([])),
    [session?.user.id],
  )

  const heroStories = trending.data?.slice(0, 4) ?? []
  const activeChallenges = challenges.data?.filter((item) => item.state === 'active') ?? []

  return (
    <PublicShell>
      {/* Hero ------------------------------------------------------------ */}
      <section className="hero">
        <div className="container hero__inner">
          <div className="hero__copy">
            <p className="hero__eyebrow">
              <Icon name="sparkle" size="0.95em" />
              Over 90,000 stories, written by readers like you
            </p>

            <h1 className="hero__title">
              Every story is waiting for the reader who needed it.
            </h1>

            <p className="hero__lede">
              Scribe is where stories are read chapter by chapter and written in
              public. Follow the serials you love, join the clubs arguing about
              them, and publish your own when you're ready.
            </p>

            <div className="hero__actions">
              <ButtonLink
                variant="primary"
                size="lg"
                to={session ? '/home' : '/register'}
                startIcon={<Icon name="book-open" />}
              >
                Start Reading
              </ButtonLink>
              <ButtonLink variant="secondary" size="lg" to="/for-writers" startIcon={<Icon name="pen" />}>
                Start Writing
              </ButtonLink>
            </div>

            <dl className="hero__stats">
              <div>
                <dt>Stories</dt>
                <dd>91,400</dd>
              </div>
              <div>
                <dt>Chapters read daily</dt>
                <dd>1.2M</dd>
              </div>
              <div>
                <dt>Active book clubs</dt>
                <dd>8,600</dd>
              </div>
            </dl>
          </div>

          {/* Editorial visual: real covers, fanned like books on a table. */}
          <div className="hero__visual" aria-hidden="true">
            {heroStories.length > 0 ? (
              <div className="hero__fan">
                {heroStories.map((story, index) => (
                  <div className="hero__fan-item" key={story.id} data-index={index}>
                    <StoryCover story={story} size="lg" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="hero__fan hero__fan--placeholder" />
            )}
          </div>
        </div>
      </section>

      {/* Continue reading ------------------------------------------------ */}
      {session && (continuing.data?.length ?? 0) > 0 ? (
        <section className="container section">
          <SectionHead
            title="Continue reading"
            subtitle="Pick up exactly where you stopped."
            to="/library"
            linkLabel="Your library"
          />
          <div className="card-grid card-grid--wide">
            {continuing.data?.map((entry) => (
              <ContinueCard key={entry.history.id} entry={entry} />
            ))}
          </div>
        </section>
      ) : null}

      {/* Trending -------------------------------------------------------- */}
      <section className="container section">
        <SectionHead
          title="Trending this week"
          subtitle="What the most readers are reading right now."
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

      {/* Genres ---------------------------------------------------------- */}
      <section className="container section">
        <SectionHead title="Featured genres" subtitle="Start somewhere you already love." to="/discover" />
        <div className="card-grid card-grid--tight">
          {genres.data?.slice(0, 8).map((genre) => (
            <GenreCard key={genre.id} genre={genre} />
          ))}
        </div>
      </section>

      {/* Authors --------------------------------------------------------- */}
      <section className="section section--tint">
        <div className="container">
          <SectionHead
            title="Popular authors"
            subtitle="Writers publishing chapter by chapter, in public."
          />
          <div className="card-grid card-grid--tight">
            {authors.data?.slice(0, 5).map((author) => (
              <AuthorCard key={author.id} author={author} />
            ))}
          </div>
        </div>
      </section>

      {/* Challenges ------------------------------------------------------ */}
      <section className="container section">
        <SectionHead
          title="Active writing challenges"
          subtitle="A prompt, a deadline, and a few thousand people writing alongside you."
          to="/challenges"
        />
        <div className="card-grid">
          {activeChallenges.slice(0, 3).map((challenge) => (
            <ChallengeCard key={challenge.id} challenge={challenge} />
          ))}
        </div>
      </section>

      {/* Clubs ----------------------------------------------------------- */}
      <section className="container section">
        <SectionHead
          title="Popular book clubs"
          subtitle="Read the same story at the same time as everyone else."
          to="/clubs"
        />
        <div className="card-grid card-grid--wide">
          {clubs.data
            ?.filter((club) => !club.isPrivate)
            .slice(0, 3)
            .map((club) => (
              <ClubCard key={club.id} club={club} />
            ))}
        </div>
      </section>

      {/* Closing CTA ----------------------------------------------------- */}
      <section className="container section">
        <div className="cta">
          <div className="cta__copy">
            <h2>Your first chapter is the hardest. Then it's just Tuesdays.</h2>
            <p>
              Publish a chapter at a time, build a channel your readers actually
              subscribe to, and see exactly which chapter they couldn't put down.
            </p>
          </div>
          <div className="cta__actions">
            <ButtonLink variant="primary" size="lg" to="/register">
              Create your account
            </ButtonLink>
            <Link className="cta__link" to="/for-writers">
              How publishing works
              <Icon name="arrow-right" size="0.9em" />
            </Link>
          </div>
        </div>
      </section>

      {/* Trust line ------------------------------------------------------ */}
      <p className="container landing__trust">
        {formatCount(2400000)} readers · free to read · free to publish
      </p>
    </PublicShell>
  )
}
