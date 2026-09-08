import { useState } from 'react'
import { useAsync } from '../../hooks/useAsync'
import { useAuth } from '../../lib/auth'
import { formatCount, formatRating } from '../../lib/format'
import * as api from '../../data/api'
import { AppShell } from '../../components/layout/AppShell'
import { Card, SectionHead, StatTile } from '../../components/ui/Card'
import { Icon } from '../../components/ui/Icon'
import { Select } from '../../components/ui/Select'
import { Skeleton } from '../../components/ui/Skeleton'
import { EmptyState, ErrorState } from '../../components/ui/States'
import { LineChart } from '../../components/charts/LineChart'
import { RatingBars } from '../../components/charts/RatingBars'
import { StoryCover } from '../../components/story/StoryCover'
import '../pages.css'
import './author.css'

const RANGES = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
]

export function AuthorAnalyticsPage() {
  const { session } = useAuth()
  const authorId = session?.user.id ?? 'u-me'

  const overview = useAsync(() => api.getAuthorOverview(authorId), [authorId])
  const [range, setRange] = useState('30')
  const [storyId, setStoryId] = useState('all')

  const stories = overview.data?.stories ?? []
  const selected = stories.find((story) => story.id === storyId) ?? null

  const series = (() => {
    const base = selected ? api.db.viewSeries(selected.id) : (overview.data?.series ?? [])
    return range === '7' ? base.slice(-7) : base
  })()

  const totals = series.reduce(
    (sum, point) => ({ views: sum.views + point.views, reads: sum.reads + point.reads }),
    { views: 0, reads: 0 },
  )

  return (
    <AppShell variant="author">
      <header className="page-head">
        <div>
          <h1 className="page-head__title">Analytics</h1>
          <p className="page-head__sub">
            What readers actually finish, and which chapter they stop at.
          </p>
        </div>
      </header>

      {overview.status === 'error' ? (
        <ErrorState message={overview.error} onRetry={overview.reload} />
      ) : overview.status === 'loading' ? (
        <Skeleton height="20rem" radius="var(--radius-lg)" />
      ) : stories.length === 0 ? (
        <EmptyState
          icon="trend"
          title="No analytics yet"
          description="Publish a chapter and numbers start arriving here within the hour."
        />
      ) : (
        <>
          {/* Filters sit in one row above the charts. */}
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
            <Select label="Range" value={range} onChange={setRange} options={RANGES} size="sm" />
          </div>

          <div className="stat-row">
            <StatTile label="Views" value={formatCount(totals.views)} icon="eye" />
            <StatTile label="Reads" value={formatCount(totals.reads)} icon="book-open" />
            <StatTile
              label="Read-through"
              value={`${Math.round((totals.reads / (totals.views || 1)) * 100)}%`}
              icon="target"
            />
            <StatTile
              label="Average rating"
              value={
                selected
                  ? formatRating(selected.ratingAverage)
                  : formatRating(overview.data?.averageRating ?? 0)
              }
              icon="star"
            />
          </div>

          <section className="page-section">
            <SectionHead
              title={selected ? `${selected.title} — traffic` : 'All stories — traffic'}
              subtitle={`Views and reads, ${range === '7' ? 'last 7 days' : 'last 30 days'}.`}
            />
            <Card>
              <LineChart data={series} title="Views and reads over time" height={280} />
            </Card>
          </section>

          <div className="two-col">
            <section className="page-section">
              <SectionHead title="Ratings" subtitle="How readers scored the work." />
              <Card>
                {selected ? (
                  <RatingBars
                    breakdown={api.getRatingBreakdown(selected)}
                    total={selected.ratingCount}
                  />
                ) : (
                  <RatingBars
                    breakdown={stories.reduce<Record<number, number>>((totalsByScore, story) => {
                      const breakdown = api.getRatingBreakdown(story)
                      for (const [score, count] of Object.entries(breakdown)) {
                        const key = Number(score)
                        totalsByScore[key] = (totalsByScore[key] ?? 0) + count
                      }
                      return totalsByScore
                    }, {})}
                    total={stories.reduce((sum, story) => sum + story.ratingCount, 0)}
                  />
                )}
              </Card>
            </section>

            <section className="page-section">
              <SectionHead title="Per story" subtitle="Ranked by views." />
              <Card padded={false}>
                <ul className="story-rows">
                  {[...stories]
                    .sort((a, b) => b.viewCount - a.viewCount)
                    .map((story) => (
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
                              {story.chapterCount} chapters
                            </span>
                          </span>
                          <span className="story-row__stat">
                            <Icon name="eye" size="0.9em" />
                            {formatCount(story.viewCount)}
                          </span>
                        </button>
                      </li>
                    ))}
                </ul>
              </Card>
            </section>
          </div>
        </>
      )}
    </AppShell>
  )
}
