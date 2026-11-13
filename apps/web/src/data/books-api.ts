/**
 * Books + Library data access.
 *
 * Every function here talks to the real Scribe API through the shared fetch
 * wrapper, so errors arrive as `ApiError` with a message safe to show.
 */

import { request } from '../lib/api-client'
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
  return request<Discover>('/books/discover')
}

export async function getGenres(): Promise<GenreSummary[]> {
  const { genres } = await request<{ genres: GenreSummary[] }>('/books/genres')
  return genres
}

export async function getBook(id: string): Promise<Book> {
  const { book } = await request<{ book: Book }>(`/books/${id}`)
  return book
}

export async function getRelatedBooks(id: string): Promise<Book[]> {
  const { books } = await request<{ books: Book[] }>(`/books/${id}/related`)
  return books
}

/* Library ---------------------------------------------------------------- */

export async function getLibrary(options: {
  status?: ReadingStatus | 'ALL'
  search?: string
} = {}): Promise<LibraryView> {
  return request<LibraryView>('/library', {
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
    body: { status },
  })
  return entry
}

export async function removeFromLibrary(bookId: string): Promise<void> {
  await request<void>(`/library/${bookId}`, {
    method: 'DELETE',
  })
}
