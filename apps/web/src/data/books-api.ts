/**
 * Books + Library data access.
 *
 * Unlike `data/api.ts`, which serves the rest of the app from `mock-db.ts`,
 * every function here talks to the real Scribe API through the shared fetch
 * wrapper, so errors arrive as `ApiError` with a message safe to show.
 */

import { request } from '../lib/api-client'
import { getAccessToken } from '../lib/access-token'
import type {
  Book,
  BookAvailability,
  BookPage,
  BookSort,
  Discover,
  GenreSummary,
  LibraryEntry,
  LibraryView,
  ReadingStatus,
} from '../types/books'

/**
 * Identifies the reader to the API while authentication is still being built.
 *
 * The API accepts this header outside production only, and ignores it entirely
 * once a real session populates the request. Delete this block — and the
 * `headers` argument below — when sign-in is wired up; nothing else changes.
 *
 * The default is the demo reader created by `pnpm --filter api seed:books`.
 */
const DEV_READER_ID =
  import.meta.env.VITE_DEV_USER_ID ?? '00000000-0000-4000-8000-000000000001'

function readerHeaders(): Record<string, string> {
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

/* Catalogue ------------------------------------------------------------- */

export interface BookFilters {
  search?: string
  genreId?: string | null
  status?: BookAvailability
  sort?: BookSort
  page?: number
  limit?: number
}

export async function listBooks(filters: BookFilters = {}): Promise<BookPage> {
  return request<BookPage>('/books', {
    headers: readerHeaders(),
    query: {
      search: filters.search?.trim() || undefined,
      genreId: filters.genreId ?? undefined,
      status: filters.status === 'all' ? undefined : filters.status,
      sort: filters.sort,
      page: filters.page === undefined ? undefined : String(filters.page),
      limit: filters.limit === undefined ? undefined : String(filters.limit),
    },
  })
}

export async function getDiscover(): Promise<Discover> {
  return request<Discover>('/books/discover', { headers: readerHeaders() })
}

export async function getGenres(): Promise<GenreSummary[]> {
  const { genres } = await request<{ genres: GenreSummary[] }>('/books/genres', {
    headers: readerHeaders(),
  })
  return genres
}

export async function getBook(id: string): Promise<Book> {
  const { book } = await request<{ book: Book }>(`/books/${id}`, {
    headers: readerHeaders(),
  })
  return book
}

export async function getRelatedBooks(id: string): Promise<Book[]> {
  const { books } = await request<{ books: Book[] }>(`/books/${id}/related`, {
    headers: readerHeaders(),
  })
  return books
}

/* Library ---------------------------------------------------------------- */

export async function getLibrary(options: {
  status?: ReadingStatus | 'ALL'
  search?: string
} = {}): Promise<LibraryView> {
  return request<LibraryView>('/library', {
    headers: readerHeaders(),
    query: {
      status: options.status === 'ALL' ? undefined : options.status,
      search: options.search?.trim() || undefined,
    },
  })
}

export async function addToLibrary(
  bookId: string,
  status: ReadingStatus = 'WANT_TO_READ',
): Promise<LibraryEntry> {
  const { entry } = await request<{ entry: LibraryEntry }>('/library', {
    method: 'POST',
    headers: readerHeaders(),
    body: { bookId, status },
  })
  return entry
}

export async function setReadingStatus(
  bookId: string,
  status: ReadingStatus,
): Promise<LibraryEntry> {
  const { entry } = await request<{ entry: LibraryEntry }>(`/library/${bookId}`, {
    method: 'PATCH',
    headers: readerHeaders(),
    body: { status },
  })
  return entry
}

export async function removeFromLibrary(bookId: string): Promise<void> {
  await request<void>(`/library/${bookId}`, {
    method: 'DELETE',
    headers: readerHeaders(),
  })
}
