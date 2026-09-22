import { useAsync } from '../../hooks/useAsync'
import { useAuth } from '../../lib/auth'
import { formatCount, formatRating, formatRelative } from '../../lib/format'
import * as analyticsApi from '../../data/analytics-api'
import * as channelsApi from '../../data/channels-api'
import { STORY_STATUS_LABELS } from '../../types/stories'
import type { StoryPerformance } from '../../types/analytics'
import { LineChart } from '../../components/charts/LineChart'
import { ButtonLink } from '../../components/ui/Button'
import { Card, SectionHead, StatTile } from '../../components/ui/Card'
import { StatusBadge } from '../../components/ui/Chip'
import { Icon } from '../../components/ui/Icon'
import { Skeleton } from '../../components/ui/Skeleton'
import { EmptyState, ErrorState } from '../../components/ui/States'
import { StoryCover } from '../../components/story/StoryCover'
import { Link } from 'react-router-dom'
import '../pages.css'
import './author.css'

/**
 * The studio's front page, answered by `GET /api/author/analytics` in one
 * request.
 *
 * The stat row used to be summed in the browser over a page of forty-eight
 * stories, which was neither every story nor an aggregate; the performance
 * chart was empty because nothing recorded a view or a chapter read. Both are
 * real now — see the note at the top of `AuthorAnalyticsPage.tsx` for which
 * numbers are events and which are lifetime counters.
 */

/** The cover art wants a genre hue and a byline; neither is worth a join. */
function coverFor(
  story: StoryPerformance,
  author: { displayName: string | null; username: string } | undefined,
) {
  return {
    id: story.id,
    title: story.title,
    coverUrl: story.coverUrl,
    genres: [{ hue: story.hue }],
    author: author ?? { displayName: null, username: '' },
  }
}

export function AuthorDashboardPage() {
  const { session, initialising } = useAuth()
  const signedIn = initialising ? undefined : session !== null

  /**
   * Thirty days: the default the analytics page opens on, so moving between
   * the two does not silently change what "recently" means.
   */
  const overview = useAsync(
    () => (signedIn ? analyticsApi.getOverview('30d') : Promise.resolve(null)),
    [signedIn],
  )
  /**
   * Filtered server-side rather than by comparing author ids here: ownership is
   * the API's to decide, and `mine=true` is the endpoint that answers it.
   */
  const channels = useAsync(
    () => channelsApi.listChannels({ mine: true, limit: 12 }),
    [],
  )

  const myChannels = channels.data?.items ?? []

  /**
   * The API ranks stories by views in the window, which is what the analytics
   * page wants. "My stories" here is a *recent* list — four rows under a
   * heading that links to the manage page — so it is re-sorted by when it was
   * last touched rather than by how it performed.
   */
  const recent = [...(overview.data?.stories ?? [])]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 4)

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-head__title">Author studio</h1>
          <p className="page-head__sub">
            How your stories are doing, and what to write next.
          </p>
        </div>
        <ButtonLink
          variant="primary"
          to="/author/stories/new"
          startIcon={<Icon name="plus" size="1em" />}
        >
          Create New Story
        </ButtonLink>
      </header>

      {overview.status === 'error' ? (
        <ErrorState message={overview.error} onRetry={overview.reload} />
      ) : overview.status === 'loading' || signedIn === undefined ? (
        <>
          <div className="stat-row">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} height="6rem" radius="var(--radius-lg)" />
            ))}
          </div>
          <Skeleton height="18rem" radius="var(--radius-lg)" />
        </>
      ) : overview.data ? (
        <>
          <div className="stat-row">
            <StatTile
              label="Views"
              value={formatCount(overview.data.totals.views)}
              detail={`last 30 days · ${formatCount(overview.data.lifetime.views)} all time`}
              icon="eye"
            />
            <StatTile
              label="Readers"
              value={formatCount(overview.data.totals.readers)}
              detail={`${formatCount(overview.data.totals.reads)} chapters opened`}
              icon="users"
            />
            <StatTile
              label="Average rating"
              value={
                overview.data.lifetime.ratingAverage === null
                  ? '—'
                  : formatRating(overview.data.lifetime.ratingAverage)
              }
              detail={`${formatCount(overview.data.lifetime.ratings)} ratings across your stories`}
              icon="star"
            />
            <StatTile
              label="Published stories"
              value={formatCount(overview.data.lifetime.published)}
              detail={`${formatCount(overview.data.lifetime.stories)} in total, drafts included`}
              icon="book-open"
            />
          </div>

          {/* Performance ------------------------------------------------- */}
          <section className="page-section">
            <SectionHead
              title="Story performance"
              subtitle="Views and chapter reads, last 30 days."
              to="/author/analytics"
              linkLabel="Full analytics"
            />
            <Card>
              <LineChart
                data={overview.data.series}
                seriesLabels={['Views', 'Chapter reads']}
                title="Views and chapter reads, last 30 days"
              />
            </Card>
          </section>

          {/* My stories -------------------------------------------------- */}
          <section className="page-section">
            <SectionHead title="My stories" to="/author/stories" linkLabel="Manage all" />

            {overview.data.stories.length === 0 ? (
              <EmptyState
                icon="pen"
                title="You haven't published a story yet"
                description="Start with one chapter. You can keep it a draft as long as you like."
                action={
                  <ButtonLink variant="primary" to="/author/stories/new">
                    Create your first story
                  </ButtonLink>
                }
              />
            ) : (
              <ul className="story-rows">
                {recent.map((story) => (
                  <li key={story.id}>
                    <Link className="story-row" to={`/author/stories/${story.slug}`}>
                      <StoryCover story={coverFor(story, session?.user)} size="xs" />
                      <span className="story-row__main">
                        <span className="story-row__title">{story.title}</span>
                        <span className="story-row__meta">
                          {story.chapterCount} chapters · updated{' '}
                          {formatRelative(story.updatedAt)}
                        </span>
                      </span>
                      <span className="story-row__stat">
                        <Icon name="eye" size="0.9em" />
                        {formatCount(story.views)}
                      </span>
                      <span className="story-row__stat">
                        <Icon name="star-filled" size="0.9em" />
                        {story.ratingAverage === null
                          ? '—'
                          : formatRating(story.ratingAverage)}
                      </span>
                      <StatusBadge
                        tone={
                          story.status === 'completed'
                            ? 'success'
                            : story.status === 'draft'
                              ? 'neutral'
                              : 'brand'
                        }
                      >
                        {STORY_STATUS_LABELS[story.status]}
                      </StatusBadge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Channels ---------------------------------------------------- */}
          <section className="page-section">
            <SectionHead
              title="Your channel"
              subtitle="Post between chapters to keep readers close."
              to="/author/channels"
              linkLabel="Manage"
            />
            {/*
              "No channel yet" is an invitation to make one, so it had better
              be true. On `length === 0` alone it was also what a failed and an
              in-flight request said -- and an author who already has a channel
              being told to start one is the kind of wrong that gets acted on.
            */}
            {channels.status === 'error' ? (
              <ErrorState message={channels.error} onRetry={channels.reload} />
            ) : channels.status === 'loading' ? (
              <Skeleton height="9rem" radius="var(--radius-lg)" />
            ) : myChannels.length === 0 ? (
              <EmptyState
                size="sm"
                icon="megaphone"
                title="No channel yet"
                description="A channel lets you post release notes and cut scenes to subscribers."
              />
            ) : (
              <div className="card-grid card-grid--wide">
                {myChannels.map((channel) => (
                  <Card key={channel.id}>
                    <h3 className="channel-card__title">
                      <Link to={`/channels/${channel.slug}`}>{channel.name}</Link>
                    </h3>
                    <p className="channel-card__desc">{channel.description}</p>
                    <p className="channel-card__foot">
                      <span>
                        <Icon name="users" size="0.9em" />
                        {formatCount(channel.subscriberCount)} subscribers
                      </span>
                      <span>
                        <Icon name="megaphone" size="0.9em" />
                        {channel.postCount} posts
                      </span>
                    </p>
                  </Card>
                ))}
              </div>
            )}
          </section>
        </>
      ) : null}
    </>
  )
}
