import { useAsync } from '../../hooks/useAsync'
import { useAuth } from '../../lib/auth'
import { formatCount, formatRating, formatRelative } from '../../lib/format'
import * as channelsApi from '../../data/channels-api'
import * as storiesApi from '../../data/stories-api'
import { STORY_STATUS_LABELS, type Story } from '../../types/stories'
import { AppShell } from '../../components/layout/AppShell'
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
 * Totals over the author's own stories.
 *
 * Only what the story rows actually carry. There is no per-day series and no
 * read count here: nothing records a view or a chapter read yet, so both used
 * to be invented client-side (reads were views × 0.46).
 */
function totalsFor(stories: Story[]) {
  const rated = stories.filter((story) => story.ratingAverage !== null)

  return {
    views: stories.reduce((sum, story) => sum + story.viewCount, 0),
    likes: stories.reduce((sum, story) => sum + story.likeCount, 0),
    chapters: stories.reduce((sum, story) => sum + story.chapterCount, 0),
    published: stories.filter((story) => story.status !== 'draft').length,
    averageRating:
      rated.length === 0
        ? null
        : rated.reduce((sum, story) => sum + (story.ratingAverage ?? 0), 0) /
          rated.length,
  }
}

export function AuthorDashboardPage() {
  const { session, initialising } = useAuth()
  const authorId = initialising ? undefined : session?.user.id

  const overview = useAsync(
    () =>
      authorId
        ? storiesApi
            .listStories({ authorId, sort: 'newest', limit: 48 })
            .then((page) => page.items)
        : Promise.resolve([]),
    [authorId],
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

  return (
    <AppShell variant="author">
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
      ) : overview.status === 'loading' || authorId === undefined ? (
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
              label="Total views"
              value={formatCount(totalsFor(overview.data).views)}
              detail="across every story you have written"
              icon="eye"
            />
            <StatTile
              label="Published stories"
              value={formatCount(totalsFor(overview.data).published)}
              detail={`${formatCount(overview.data.length)} in total, drafts included`}
              icon="book-open"
            />
            <StatTile
              label="Average rating"
              value={
                totalsFor(overview.data).averageRating === null
                  ? '—'
                  : formatRating(totalsFor(overview.data).averageRating ?? 0)
              }
              detail="across your rated stories"
              icon="star"
            />
            <StatTile
              label="Likes"
              value={formatCount(totalsFor(overview.data).likes)}
              detail={`${formatCount(totalsFor(overview.data).chapters)} chapters written`}
              icon="heart"
            />
          </div>

          {/* Performance ------------------------------------------------- */}
          <section className="page-section">
            <SectionHead
              title="Story performance"
              subtitle="Views and reads over time."
              to="/author/analytics"
              linkLabel="Full analytics"
            />
            <Card>
              <EmptyState
                size="sm"
                icon="trend"
                title="No day-by-day figures yet"
                description="Views and reads are lifetime totals today. A daily series needs view and read events to be recorded first."
              />
            </Card>
          </section>

          {/* My stories -------------------------------------------------- */}
          <section className="page-section">
            <SectionHead title="My stories" to="/author/stories" linkLabel="Manage all" />

            {overview.data.length === 0 ? (
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
                {overview.data.slice(0, 4).map((story) => (
                  <li key={story.id}>
                    <Link className="story-row" to={`/author/stories/${story.slug}`}>
                      <StoryCover story={story} size="xs" />
                      <span className="story-row__main">
                        <span className="story-row__title">{story.title}</span>
                        <span className="story-row__meta">
                          {story.chapterCount} chapters · updated{' '}
                          {formatRelative(story.updatedAt)}
                        </span>
                      </span>
                      <span className="story-row__stat">
                        <Icon name="eye" size="0.9em" />
                        {formatCount(story.viewCount)}
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
            {myChannels.length === 0 ? (
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
    </AppShell>
  )
}
