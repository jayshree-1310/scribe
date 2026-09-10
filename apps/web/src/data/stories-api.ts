/**
 * Story + chapter data access.
 *
 * Talks to the real Scribe API through the shared fetch wrapper, so errors
 * arrive as `ApiError` with a message that is safe to show. Follows the shape
 * of `books-api.ts`; the two cover opposite halves of `content.Story`.
 */

import { request } from '../lib/api-client'
import { getAccessToken } from '../lib/access-token'
import type {
  Chapter,
  ChapterSummary,
  Story,
  StoryGenreSummary,
  StoryPage,
  StorySort,
} from '../types/stories'

/**
 * Identifies the reader to the API while authentication is still being built.
 *
 * Same stopgap as `books-api.ts`: the API honours this header outside
 * production only, and ignores it entirely once a real session populates the
 * request. Delete this block — and the `headers` argument below — when sign-in
 * is wired up.
 *
 * It matters more here than for books: the author of a draft is the only person
 * who can see it, so who the API thinks is calling decides what comes back.
 * `data/authoring-api.ts` shares it for the same reason -- every write it makes
 * is attributed to whoever the API thinks is calling.
 */
const DEV_READER_ID =
  import.meta.env.VITE_DEV_USER_ID ?? '00000000-0000-4000-8000-000000000001'

export function readerHeaders(): Record<string, string> {
  if (import.meta.env.PROD) return {}

  /**
   * Never alongside a real session. The API prefers the bearer token when both
   * are present, but sending both means a request made before the token has
   * been restored is attributed to the demo reader rather than to the person
   * signed in — which silently hides their own drafts.
   */
  if (getAccessToken() !== null) return {}

  return { 'X-Scribe-User-Id': DEV_READER_ID }
}

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
    headers: readerHeaders(),
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
    { headers: readerHeaders() },
  )
  return genres
}

/** `slugOrId` because the API accepts either, and older links carry ids. */
export async function getStory(slugOrId: string): Promise<Story> {
  const { story } = await request<{ story: Story }>(
    `/stories/${encodeURIComponent(slugOrId)}`,
    { headers: readerHeaders() },
  )
  return story
}

export async function getChapters(
  slugOrId: string,
): Promise<ChapterSummary[]> {
  const { chapters } = await request<{ chapters: ChapterSummary[] }>(
    `/stories/${encodeURIComponent(slugOrId)}/chapters`,
    { headers: readerHeaders() },
  )
  return chapters
}

export async function getChapter(
  slugOrId: string,
  number: number,
): Promise<Chapter> {
  const { chapter } = await request<{ chapter: Chapter }>(
    `/stories/${encodeURIComponent(slugOrId)}/chapters/${number}`,
    { headers: readerHeaders() },
  )
  return chapter
}

export async function getRelatedStories(slugOrId: string): Promise<Story[]> {
  const { stories } = await request<{ stories: Story[] }>(
    `/stories/${encodeURIComponent(slugOrId)}/related`,
    { headers: readerHeaders() },
  )
  return stories
}
