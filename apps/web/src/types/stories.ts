/**
 * Story + chapter types.
 *
 * These mirror the API responses in `apps/api/src/services/stories.ts`
 * exactly, the same way `types/books.ts` mirrors the books service. Both read
 * the one `content.Story` table from opposite sides — imported editions there,
 * stories written on Scribe here (`docs/content-model.md`) — which is why the
 * shared fields are named identically in both files.
 *
 * Separate from `domain.ts`, which describes the mock layer the rest of the app
 * still runs on.
 */

export interface StoryAuthor {
  id: string
  username: string
  /** Absent for password signups; fall back to the username for display. */
  displayName: string | null
  avatarUrl: string | null
}

export interface StoryGenre {
  id: string
  name: string
  /** Base hue the cover art and genre chips are composed from. */
  hue: number
}

/** Derived by the API from `listedAt` and `isCompleted`; never stored. */
export type StoryStatus = 'draft' | 'ongoing' | 'completed'

export type StorySource = 'SCRIBE' | 'CATALOGUE'

export interface Story {
  id: string
  slug: string
  title: string
  description: string | null
  coverUrl: string | null
  source: StorySource
  status: StoryStatus
  isCompleted: boolean
  kidsAppropriate: boolean
  viewCount: number
  likeCount: number
  ratingAverage: number | null
  ratingCount: number
  /** Chapters the caller may read, not chapters that exist. */
  chapterCount: number
  /** Summed over those same chapters. */
  wordCount: number
  listedAt: string | null
  publishedAt: string | null
  createdAt: string
  updatedAt: string
  author: StoryAuthor
  genres: StoryGenre[]
}

export interface StoryPage {
  items: Story[]
  page: number
  limit: number
  total: number
  totalPages: number
  hasMore: boolean
}

export interface StoryGenreSummary extends StoryGenre {
  storyCount: number
}

export interface ChapterSummary {
  id: string
  storyId: string
  number: number
  title: string
  wordCount: number
  publishedAt: string | null
}

export interface ChapterMedia {
  id: string
  type: 'IMAGE' | 'AUDIO' | 'VIDEO' | 'LINK'
  url: string
  displayOrder: number
}

export interface Chapter extends ChapterSummary {
  /** Paragraphs separated by blank lines; see `paragraphsOf`. */
  content: string
  multimedia: ChapterMedia[]
  /** Neighbouring readable chapters, or null at either edge. */
  previousNumber: number | null
  nextNumber: number | null
}

/* Reading progress ----------------------------------------------------- */

/** Mirrors `ReadingProgress` in `apps/api/src/services/reading.ts`. */
export interface ReadingProgress {
  storyId: string
  chapterId: string | null
  /** The chapter's reader-facing number, for building a resume link. */
  chapterNumber: number | null
  /**
   * Character offset into that chapter's `content`, not a scroll position:
   * font size and reading width are preferences, so a pixel offset restores
   * to the wrong paragraph the moment either changes.
   */
  offset: number
  /** Whole-story completion, 0–100, weighted by chapter word counts. */
  percentComplete: number
  lastReadAt: string
}

/** A resume point with enough of its story attached to render a card. */
export interface ContinueEntry {
  progress: ReadingProgress
  story: Story
  /** Null when the chapter was deleted since the position was saved. */
  chapter: { id: string; number: number; title: string } | null
}

export const STORY_SORTS = ['trending', 'newest', 'rating', 'views'] as const

export type StorySort = (typeof STORY_SORTS)[number]

export const STORY_SORT_LABELS: Record<StorySort, string> = {
  trending: 'Trending now',
  newest: 'Recently published',
  rating: 'Highest rated',
  views: 'Most read',
}

export const STORY_STATUS_LABELS: Record<StoryStatus, string> = {
  draft: 'Draft',
  ongoing: 'Ongoing',
  completed: 'Completed',
}

/** Words a typical reader gets through in a minute. */
const WORDS_PER_MINUTE = 220

export function readingMinutes(wordCount: number): number {
  return Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE))
}

/**
 * Splits a chapter body for rendering.
 *
 * The API stores and returns one string, because that is what the editor will
 * post; paragraphs are blank-line separated. Splitting here rather than
 * server-side keeps the round trip a faithful copy of what was written.
 */
export function paragraphsOf(content: string): string[] {
  return content
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
}

/**
 * Author display name.
 *
 * `displayName` is null for accounts created with a password, which have never
 * been asked for one, so the handle is title-cased as a stand-in — the same
 * fallback `types/books.ts` applies to catalogue authors.
 */
export function storyAuthorName(author: StoryAuthor): string {
  if (author.displayName && author.displayName.trim().length > 0) {
    return author.displayName
  }

  return author.username
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}
