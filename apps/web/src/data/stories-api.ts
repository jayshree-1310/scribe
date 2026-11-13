/**
 * Story + chapter data access.
 *
 * Talks to the real Scribe API through the shared fetch wrapper, so errors
 * arrive as `ApiError` with a message that is safe to show. Follows the shape
 * of `books-api.ts`; the two cover opposite halves of `content.Story`.
 */

import { request } from '../lib/api-client'
import { tourPreviewHeaders } from '../lib/tour-preview'
import type {
  Chapter,
  ChapterSummary,
  Story,
  StoryGenreSummary,
  StoryPage,
  StorySort,
} from '../types/stories'

export interface StoryFilters {
  search?: string
  genreId?: string | null
  /** One author's stories; their own drafts too when they are the caller. */
  authorId?: string | null
  sort?: StorySort
  page?: number
  limit?: number
}

export async function listStories(
  filters: StoryFilters = {},
): Promise<StoryPage> {
  return request<StoryPage>('/stories', {
    query: {
      search: filters.search?.trim() || undefined,
      genreId: filters.genreId ?? undefined,
      authorId: filters.authorId ?? undefined,
      sort: filters.sort,
      page: filters.page === undefined ? undefined : String(filters.page),
      limit: filters.limit === undefined ? undefined : String(filters.limit),
    },
  })
}

export async function getGenres(): Promise<StoryGenreSummary[]> {
  const { genres } = await request<{ genres: StoryGenreSummary[] }>(
    '/stories/genres',
  )
  return genres
}

/** `slugOrId` because the API accepts either, and older links carry ids. */
/**
 * The two reads the API counts -- a story view, a chapter read -- carry the
 * product tour's marker while it is on screen. See `lib/tour-preview.ts`.
 */
export async function getStory(slugOrId: string): Promise<Story> {
  const { story } = await request<{ story: Story }>(
    `/stories/${encodeURIComponent(slugOrId)}`,
    { headers: tourPreviewHeaders() },
  )
  return story
}

export async function getChapters(
  slugOrId: string,
): Promise<ChapterSummary[]> {
  const { chapters } = await request<{ chapters: ChapterSummary[] }>(
    `/stories/${encodeURIComponent(slugOrId)}/chapters`,
  )
  return chapters
}

export async function getChapter(
  slugOrId: string,
  number: number,
): Promise<Chapter> {
  const { chapter } = await request<{ chapter: Chapter }>(
    `/stories/${encodeURIComponent(slugOrId)}/chapters/${number}`,
    { headers: tourPreviewHeaders() },
  )
  return chapter
}

export async function getRelatedStories(slugOrId: string): Promise<Story[]> {
  const { stories } = await request<{ stories: Story[] }>(
    `/stories/${encodeURIComponent(slugOrId)}/related`,
  )
  return stories
}
