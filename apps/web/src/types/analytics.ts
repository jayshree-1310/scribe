/**
 * Author analytics types.
 *
 * These mirror the API responses in `apps/api/src/services/analytics.ts`
 * exactly, the same way `types/challenges.ts` mirrors the challenges service.
 *
 * The distinction the whole shape turns on: **`totals` is the window, and
 * `lifetime` is forever.** `totals.views` counts view events inside the range;
 * `lifetime.views` is the `viewCount` column summed, which carries whatever a
 * seeded story was imported with as well as every event since. A range figure
 * far below the lifetime one is the event log being younger than the story,
 * not a bug.
 *
 * What the mock invented and nothing records, so it is absent here: a
 * read-through rate, and "reads" as a fixed multiple of views. A read is now a
 * chapter actually opened.
 */

export const ANALYTICS_RANGES = ['7d', '30d', '90d'] as const

export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number]

export const ANALYTICS_RANGE_LABELS: Record<AnalyticsRange, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
}

/** One day of the chart. The shape `components/charts/LineChart.tsx` takes. */
export interface SeriesPoint {
  /** `YYYY-MM-DD`, UTC. */
  date: string
  views: number
  reads: number
}

/** Everything that happened inside the requested window. */
export interface RangeTotals {
  views: number
  reads: number
  /** Distinct visitors across both event kinds — never views plus reads. */
  readers: number
  comments: number
  ratings: number
}

/** Everything the author has accumulated, across every story they have. */
export interface LifetimeTotals {
  stories: number
  published: number
  chapters: number
  words: number
  views: number
  likes: number
  ratings: number
  ratingAverage: number | null
}

/** One story, its lifetime counters and what it did inside the range. */
export interface StoryPerformance {
  id: string
  slug: string
  title: string
  coverUrl: string | null
  status: 'draft' | 'ongoing' | 'completed'
  chapterCount: number
  wordCount: number
  updatedAt: string
  /** The primary genre's hue, for the cover art. See the API's note on it. */
  hue: number
  lifetimeViews: number
  likeCount: number
  ratingCount: number
  ratingAverage: number | null
  views: number
  reads: number
  readers: number
}

export interface ChapterPerformance {
  id: string
  number: number
  title: string
  wordCount: number
  published: boolean
  reads: number
  readers: number
}

interface RangeWindow {
  range: AnalyticsRange
  /** First day counted, `YYYY-MM-DD` inclusive. */
  from: string
  /** Last day counted — today in UTC — inclusive. */
  to: string
}

export interface AuthorOverview extends RangeWindow {
  totals: RangeTotals
  lifetime: LifetimeTotals
  /** Exactly as many points as the range has days, zeroes included. */
  series: SeriesPoint[]
  /** Every story the author has, most viewed in the range first. */
  stories: StoryPerformance[]
}

export interface StoryAnalytics extends RangeWindow {
  story: StoryPerformance
  series: SeriesPoint[]
  chapters: ChapterPerformance[]
}
