import { useState } from 'react'
import { useAsync } from '../../hooks/useAsync'
import { useAuth } from '../../lib/auth'
import { formatCount, formatRating, formatRelative } from '../../lib/format'
import * as storiesApi from '../../data/stories-api'
import { STORY_STATUS_LABELS, readingMinutes } from '../../types/stories'
import { AppShell } from '../../components/layout/AppShell'
import { Card, SectionHead, StatTile } from '../../components/ui/Card'
import { StatusBadge } from '../../components/ui/Chip'
import { Icon } from '../../components/ui/Icon'
import { Select } from '../../components/ui/Select'
import { Skeleton } from '../../components/ui/Skeleton'
import { EmptyState, ErrorState } from '../../components/ui/States'
import { StoryCover } from '../../components/story/StoryCover'
import '../pages.css'
import './author.css'

/**
 * What this page can honestly show.
 *
 * `viewCount` and `likeCount` are lifetime counters on the story row; ratings
 * are real rows. Nothing records *when* a view or a read happened, so there is
 * no time series, no read count and no read-through rate here — all three used
 * to be generated in the browser (reads were views × 0.46, and the traffic
 * chart came from a random-walk generator). They come back with view and
 * chapter-read events.
 */
export function AuthorAnalyticsPage() {
  const { session, initialising } = useAuth()
  const authorId = initialising ? undefined : session?.user.id

  const overview = useAsync(
    () =>
      authorId
        ? storiesApi
            .listStories({ authorId, sort: 'views', limit: 48 })
            .then((page) => page.items)
        : Promise.resolve([]),
    [authorId],
  )

  const [storyId, setStoryId] = useState('all')

  const stories = overview.data ?? []
  const selected = stories.find((story) => story.id === storyId) ?? null
  const scope = selected ? [selected] : stories

  const totals = {
    views: scope.reduce((sum, story) => sum + story.viewCount, 0),
    likes: scope.reduce((sum, story) => sum + story.likeCount, 0),
    chapters: scope.reduce((sum, story) => sum + story.chapterCount, 0),
    words: scope.reduce((sum, story) => sum + story.wordCount, 0),
    ratings: scope.reduce((sum, story) => sum + story.ratingCount, 0),
  }

  const rated = scope.filter((story) => story.ratingAverage !== null)
  const averageRating =
    rated.length === 0
      ? null
      : rated.reduce((sum, story) => sum + (story.ratingAverage ?? 0), 0) / rated.length

  return (
    <AppShell variant="author">
      <header className="page-head">
        <div>
          <h1 className="page-head__title">Analytics</h1>
          <p className="page-head__sub">How your stories are doing so far.</p>
        </div>
      </header>

      {overview.status === 'error' ? (
        <ErrorState message={overview.error} onRetry={overview.reload} />
      ) : overview.status === 'loading' || authorId === undefined ? (
        <Skeleton height="20rem" radius="var(--radius-lg)" />
      ) : stories.length === 0 ? (
        <EmptyState
          icon="trend"
          title="No stories yet"
          description="Publish a chapter and its figures will appear here."
        />
      ) : (
        <>
          <div className="analytics__filters">
            <Select
              label="Story"
              value={storyId}
              onChange={setStoryId}
              options={[
                { value: 'all', label: 'All stories' },
                ...stories.map((story) => ({ value: story.id, label: story.title })),
              ]}
              size="sm"
            />
          </div>

          <div className="stat-row">
            <StatTile label="Views" value={formatCount(totals.views)} icon="eye" />
            <StatTile label="Likes" value={formatCount(totals.likes)} icon="heart" />
            <StatTile
              label="Average rating"
              value={averageRating === null ? '—' : formatRating(averageRating)}
              detail={`${formatCount(totals.ratings)} ${totals.ratings === 1 ? 'rating' : 'ratings'}`}
              icon="star"
            />
            <StatTile
              label="Published"
              value={formatCount(totals.chapters)}
              detail={`${formatCount(totals.words)} words`}
              icon="book-open"
            />
          </div>

          <section className="page-section">
            <SectionHead
              title="Views and reads over time"
              subtitle="Needs per-day figures, which are not recorded yet."
            />
            <Card>
              <EmptyState
                size="sm"
                icon="trend"
                title="No day-by-day figures yet"
                description="Views above are lifetime totals. A daily series, a read count and a read-through rate all need a story view and a chapter read to be recorded as events first."
              />
            </Card>
          </section>

          <section className="page-section">
            <SectionHead title="Per story" subtitle="Ranked by views." />
            <Card padded={false}>
              <ul className="story-rows">
                {stories.map((story) => (
                  <li key={story.id}>
                    <button
                      type="button"
                      className="story-row story-row--button"
                      onClick={() => setStoryId(story.id)}
                    >
                      <StoryCover story={story} size="xs" />
                      <span className="story-row__main">
                        <span className="story-row__title">{story.title}</span>
                        <span className="story-row__meta">
                          {story.chapterCount} chapters ·{' '}
                          {readingMinutes(story.wordCount)} min · updated{' '}
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
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        </>
      )}
    </AppShell>
  )
}
