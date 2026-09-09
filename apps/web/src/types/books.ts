/**
 * Books + Library types.
 *
 * These mirror the API responses in `apps/api/src/services/{books,library}.ts`
 * exactly. They are separate from `domain.ts` — which describes the mock data
 * layer the rest of the app still runs on — because this feature reads from the
 * real backend and its shapes are the backend's to define.
 */

export interface BookAuthor {
  id: string
  username: string
}

export interface BookGenre {
  id: string
  name: string
  /** Base hue the cover art and genre chips are composed from. */
  hue: number
}

export const READING_STATUSES = ['WANT_TO_READ', 'READING', 'FINISHED'] as const

export type ReadingStatus = (typeof READING_STATUSES)[number]

export const READING_STATUS_LABELS: Record<ReadingStatus, string> = {
  WANT_TO_READ: 'Want to read',
  READING: 'Reading',
  FINISHED: 'Finished',
}

export interface Book {
  id: string
  title: string
  description: string | null
  coverUrl: string | null
  isbn: string | null
  publisher: string | null
  publishedAt: string | null
  pageCount: number | null
  isCompleted: boolean
  kidsAppropriate: boolean
  viewCount: number
  likeCount: number
  ratingAverage: number | null
  createdAt: string
  updatedAt: string
  author: BookAuthor
  genres: BookGenre[]
  /** The signed-in reader's shelf for this book; `null` when it is on none. */
  libraryStatus: ReadingStatus | null
}

export interface BookPage {
  items: Book[]
  page: number
  limit: number
  total: number
  totalPages: number
  hasMore: boolean
}

export interface GenreSummary extends BookGenre {
  bookCount: number
}

export interface DiscoverSection {
  genre: BookGenre
  books: Book[]
}

export interface Discover {
  featured: Book | null
  trending: Book[]
  recommended: Book[]
  sections: DiscoverSection[]
}

export interface LibraryEntry {
  id: string
  status: ReadingStatus
  addedAt: string
  updatedAt: string
  book: Book
}

export type LibraryCounts = Record<ReadingStatus, number> & { ALL: number }

export interface LibraryView {
  items: LibraryEntry[]
  counts: LibraryCounts
}

export const BOOK_SORTS = [
  'recent',
  'trending',
  'popular',
  'top-rated',
  'title',
] as const

export type BookSort = (typeof BOOK_SORTS)[number]

export const BOOK_SORT_LABELS: Record<BookSort, string> = {
  recent: 'Recently added',
  trending: 'Trending now',
  popular: 'Most loved',
  'top-rated': 'Highest rated',
  title: 'Title A–Z',
}

export type BookAvailability = 'all' | 'completed' | 'ongoing'

/**
 * Author display name.
 *
 * `auth.User` has no display-name column yet — that model belongs to the
 * authentication work in flight — so the handle is titled-cased for display.
 * Swap this for `author.displayName` once the column exists.
 */
export function authorName(author: BookAuthor): string {
  return author.username
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}
