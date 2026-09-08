import { useAsync } from '../../hooks/useAsync'
import { useAuth } from '../../lib/auth'
import { formatCount, formatRating, formatRelative } from '../../lib/format'
import * as api from '../../data/api'
import { AppShell } from '../../components/layout/AppShell'
import { ButtonLink } from '../../components/ui/Button'
import { Card, SectionHead, StatTile } from '../../components/ui/Card'
import { StatusBadge } from '../../components/ui/Chip'
import { Icon } from '../../components/ui/Icon'
import { Skeleton } from '../../components/ui/Skeleton'
import { EmptyState, ErrorState } from '../../components/ui/States'
import { LineChart } from '../../components/charts/LineChart'
import { StoryCover } from '../../components/story/StoryCover'
import { Link } from 'react-router-dom'
import '../pages.css'
import './author.css'

export function AuthorDashboardPage() {
  const { session } = useAuth()
  const authorId = session?.user.id ?? 'u-me'

  const overview = useAsync(() => api.getAuthorOverview(authorId), [authorId])
  const channels = useAsync(() => api.getChannels(), [])

  const myChannels = channels.data?.filter((channel) => channel.authorId === authorId) ?? []

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
      ) : overview.status === 'loading' ? (
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
              value={formatCount(overview.data.totalViews)}
              detail="+12.4% vs last month"
              trend="up"
              icon="eye"
            />
            <StatTile
              label="Total reads"
              value={formatCount(overview.data.totalReads)}
              detail="46% of views finish a chapter"
              icon="book-open"
            />
            <StatTile
              label="Average rating"
              value={formatRating(overview.data.averageRating)}
              detail="across all published stories"
              icon="star"
            />
            <StatTile
              label="Reader engagement"
              value={`${overview.data.engagementRate}%`}
              detail="likes and comments per view"
              trend="up"
              icon="heart"
            />
          </div>

          {/* Performance ------------------------------------------------- */}
          <section className="page-section">
            <SectionHead
              title="Story performance"
              subtitle="Views and reads across your stories, last 30 days."
              to="/author/analytics"
              linkLabel="Full analytics"
            />
            <Card>
              <LineChart
                data={overview.data.series}
                title="Views and reads over the last 30 days"
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
                {overview.data.stories.slice(0, 4).map((story) => (
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
                        {formatRating(story.ratingAverage)}
                      </span>
                      <StatusBadge
                        tone={story.status === 'completed' ? 'success' : 'brand'}
                      >
                        {story.status}
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
