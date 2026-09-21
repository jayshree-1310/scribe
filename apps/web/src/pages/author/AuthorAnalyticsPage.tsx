import { useState } from 'react'
import { useAsync } from '../../hooks/useAsync'
import { useAuth } from '../../lib/auth'
import { formatCount, formatRating, formatRelative } from '../../lib/format'
import * as analyticsApi from '../../data/analytics-api'
import {
  ANALYTICS_RANGES,
  ANALYTICS_RANGE_LABELS,
  type AnalyticsRange,
  type ChapterPerformance,
  type SeriesPoint,
  type StoryPerformance,
} from '../../types/analytics'
import { STORY_STATUS_LABELS, readingMinutes } from '../../types/stories'
import { AppShell } from '../../components/layout/AppShell'
import { LineChart } from '../../components/charts/LineChart'
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
 * What this page shows, and where each number comes from.
 *
 * `GET /api/author/analytics` answers the whole page in one request: the
 * window's totals, the author's lifetime totals, a point per day and a row per
 * story. Picking one story swaps in `GET /api/author/analytics/stories/:id`,
 * which adds where that story's reads fell across its chapters — a question
 * the overview cannot answer for every story at once without a query per
 * chapter on the platform.
 *
 * Views and reads inside the range are *events*, deduped per reader per day,
 * so a refresh does not move them. "Views" on a story row is the lifetime
 * counter instead, which is the number the catalogue sorts on — the two are
 * labelled differently on purpose.
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

function toneFor(status: StoryPerformance['status']) {
  return status === 'completed' ? 'success' : status === 'draft' ? 'neutral' : 'brand'
}

export function AuthorAnalyticsPage() {
  const { session, initialising } = useAuth()
  const signedIn = initialising ? undefined : session !== null

  const [range, setRange] = useState<AnalyticsRange>('30d')
  const [storyId, setStoryId] = useState('all')

  const overview = useAsync(
    () => (signedIn ? analyticsApi.getOverview(range) : Promise.resolve(null)),
    [signedIn, range],
  )

  /**
   * Only fetched once a story is picked. Keyed on the id *and* the range, so
   * changing either re-asks rather than showing one story's series under
   * another's heading.
   */
  const detail = useAsync(
    () =>
      signedIn && storyId !== 'all'
        ? analyticsApi.getStoryAnalytics(storyId, range)
        : Promise.resolve(null),
    [signedIn, storyId, range],
  )

  const stories = overview.data?.stories ?? []

  // While a story's own figures are still loading, the row already on screen
  // stands in for them: every field but the chapter breakdown is in it.
  const selected =
    storyId === 'all'
      ? null
      : (detail.data?.story ?? stories.find((story) => story.id === storyId) ?? null)

  const series: SeriesPoint[] =
    (storyId === 'all' ? overview.data?.series : detail.data?.series) ?? []

  const chapters: ChapterPerformance[] = detail.data?.chapters ?? []

  const totals = overview.data?.totals
  const lifetime = overview.data?.lifetime

  /** One story's numbers when one is picked, otherwise every story's. */
  const scope = selected
    ? {
        views: selected.views,
        reads: selected.reads,
        readers: selected.readers,
        lifetimeViews: selected.lifetimeViews,
        ratings: selected.ratingCount,
        ratingAverage: selected.ratingAverage,
      }
    : {
        views: totals?.views ?? 0,
        reads: totals?.reads ?? 0,
        readers: totals?.readers ?? 0,
        lifetimeViews: lifetime?.views ?? 0,
        ratings: lifetime?.ratings ?? 0,
        ratingAverage: lifetime?.ratingAverage ?? null,
      }

  const windowLabel = ANALYTICS_RANGE_LABELS[range].toLowerCase()

  return (
    <AppShell variant="author">
      <header className="page-head">
        <div>
          <h1 className="page-head__title">Analytics</h1>
          <p className="page-head__sub">
            Who is reading, and when. Counted once per reader per day.
          </p>
        </div>
      </header>

      {overview.status === 'error' ? (
        <ErrorState message={overview.error} onRetry={overview.reload} />
      ) : overview.status === 'loading' || signedIn === undefined ? (
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
            <Select
              label="Range"
              value={range}
              onChange={setRange}
              options={ANALYTICS_RANGES.map((value) => ({
                value,
                label: ANALYTICS_RANGE_LABELS[value],
              }))}
              size="sm"
            />
          </div>

          <div className="stat-row">
            <StatTile
              label="Views"
              value={formatCount(scope.views)}
              detail={`${formatCount(scope.lifetimeViews)} all time`}
              icon="eye"
            />
            <StatTile
              label="Chapter reads"
              value={formatCount(scope.reads)}
              detail={windowLabel}
              icon="book-open"
            />
            <StatTile
              label="Readers"
              value={formatCount(scope.readers)}
              detail="distinct people, not visits"
              icon="users"
            />
            <StatTile
              label="Average rating"
              value={
                scope.ratingAverage === null ? '—' : formatRating(scope.ratingAverage)
              }
              detail={`${formatCount(scope.ratings)} ${
                scope.ratings === 1 ? 'rating' : 'ratings'
              }`}
              icon="star"
            />
          </div>

          <section className="page-section">
            <SectionHead
              title="Views and reads over time"
              subtitle={
                selected
                  ? `${selected.title} · ${windowLabel}`
                  : `Every story · ${windowLabel}`
              }
            />
            <Card>
              {storyId !== 'all' && detail.status === 'error' ? (
                <ErrorState message={detail.error} onRetry={detail.reload} />
              ) : storyId !== 'all' && detail.status === 'loading' ? (
                <Skeleton height="15rem" radius="var(--radius-md)" />
              ) : (
                <LineChart
                  data={series}
                  seriesLabels={['Views', 'Chapter reads']}
                  title={`Views and chapter reads, ${windowLabel}`}
                />
              )}
            </Card>
          </section>

          {/* One story's chapters, only when one is picked -------------- */}
          {selected ? (
            <section className="page-section">
              <SectionHead
                title="Where readers got to"
                subtitle="Reads per chapter, in reading order."
              />
              <Card padded={false}>
                {detail.status === 'loading' ? (
                  <Skeleton height="10rem" radius="var(--radius-md)" />
                ) : chapters.length === 0 ? (
                  <EmptyState
                    size="sm"
                    icon="book-open"
                    title="No chapters yet"
                    description="A chapter has to exist before anybody can open it."
                  />
                ) : (
                  <ul className="story-rows">
                    {chapters.map((chapter) => (
                      <li key={chapter.id}>
                        <span className="story-row">
                          <span className="story-row__main">
                            <span className="story-row__title">
                              {chapter.number}. {chapter.title}
                            </span>
                            <span className="story-row__meta">
                              {readingMinutes(chapter.wordCount)} min ·{' '}
                              {formatCount(chapter.readers)}{' '}
                              {chapter.readers === 1 ? 'reader' : 'readers'}
                            </span>
                          </span>
                          <span className="story-row__stat">
                            <Icon name="book-open" size="0.9em" />
                            {formatCount(chapter.reads)}
                          </span>
                          <StatusBadge tone={chapter.published ? 'brand' : 'neutral'}>
                            {chapter.published ? 'Published' : 'Draft'}
                          </StatusBadge>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </section>
          ) : null}

          <section className="page-section">
            <SectionHead title="Per story" subtitle={`Ranked by views, ${windowLabel}.`} />
            <Card padded={false}>
              <ul className="story-rows">
                {stories.map((story) => (
                  <li key={story.id}>
                    <button
                      type="button"
                      className="story-row story-row--button"
                      onClick={() =>
                        setStoryId(story.id === storyId ? 'all' : story.id)
                      }
                    >
                      <StoryCover story={coverFor(story, session?.user)} size="xs" />
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
                        {formatCount(story.views)}
                      </span>
                      <span className="story-row__stat">
                        <Icon name="book-open" size="0.9em" />
                        {formatCount(story.reads)}
                      </span>
                      <span className="story-row__stat">
                        <Icon name="star-filled" size="0.9em" />
                        {story.ratingAverage === null
                          ? '—'
                          : formatRating(story.ratingAverage)}
                      </span>
                      <StatusBadge tone={toneFor(story.status)}>
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
