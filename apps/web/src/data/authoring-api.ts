/**
 * The author's own stories and chapters: everything that writes.
 *
 * `stories-api.ts` is the reader's half — discovery, one story, chapters as
 * summaries. This module talks to `/api/author`, which needs a session and
 * addresses stories and chapters by id rather than by slug, because those are
 * the ids the editor already holds.
 *
 * Every call here can 403 (`ApiError.status === 403`) when the story is not
 * the caller's, which is the API refusing rather than the request failing —
 * show its message, do not retry.
 */

import { request } from '../lib/api-client'
import { readerHeaders } from './stories-api'
import type { Story, StoryPage } from '../types/stories'

/**
 * A chapter as its author sees it: the body included, published or not.
 *
 * Wider than `ChapterSummary` in `types/stories.ts` — the reader's chapter
 * list deliberately omits the prose so it costs one query — and narrower than
 * the reader's `Chapter`, which carries prev/next links only a reader needs.
 */
export interface AuthoredChapter {
  id: string
  storyId: string
  number: number
  title: string
  content: string
  wordCount: number
  publishedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface AuthoredMedia {
  id: string
  chapterId: string
  type: 'IMAGE' | 'AUDIO' | 'VIDEO' | 'LINK'
  url: string
  displayOrder: number
}

export interface StoryDraft {
  title: string
  description?: string
  coverUrl?: string
  /** Replaces the story's whole genre set; omit to leave it alone. */
  genreIds?: string[]
  kidsAppropriate?: boolean
  isCompleted?: boolean
}

/* Stories ---------------------------------------------------------------- */

/** The caller's own stories, drafts included. */
export function listMyStories(page = 1, limit = 48): Promise<StoryPage> {
  return request<StoryPage>('/author/stories', {
    headers: readerHeaders(),
    query: { page: String(page), limit: String(limit) },
  })
}

export async function createStory(draft: StoryDraft): Promise<Story> {
  const { story } = await request<{ story: Story }>('/author/stories', {
    method: 'POST',
    headers: readerHeaders(),
    body: draft,
  })
  return story
}

export async function updateStory(
  storyId: string,
  draft: Partial<StoryDraft>,
): Promise<Story> {
  const { story } = await request<{ story: Story }>(
    `/author/stories/${storyId}`,
    { method: 'PATCH', headers: readerHeaders(), body: draft },
  )
  return story
}

export function deleteStory(storyId: string): Promise<void> {
  return request<void>(`/author/stories/${storyId}`, {
    method: 'DELETE',
    headers: readerHeaders(),
  })
}

/**
 * Lists the story publicly. The API refuses if nothing in it is published yet,
 * so publish the chapters first — see `publishChapter`.
 */
export async function publishStory(storyId: string): Promise<Story> {
  const { story } = await request<{ story: Story }>(
    `/author/stories/${storyId}/publish`,
    { method: 'POST', headers: readerHeaders() },
  )
  return story
}

export async function unpublishStory(storyId: string): Promise<Story> {
  const { story } = await request<{ story: Story }>(
    `/author/stories/${storyId}/unpublish`,
    { method: 'POST', headers: readerHeaders() },
  )
  return story
}

/* Chapters --------------------------------------------------------------- */

/** Every chapter of one of the caller's stories, bodies included. */
export async function listMyChapters(
  storyId: string,
): Promise<AuthoredChapter[]> {
  const { chapters } = await request<{ chapters: AuthoredChapter[] }>(
    `/author/stories/${storyId}/chapters`,
    { headers: readerHeaders() },
  )
  return chapters
}

/** Appends an unpublished chapter after the last one. */
export async function createChapter(
  storyId: string,
  chapter: { title: string; content?: string },
): Promise<AuthoredChapter> {
  const { chapter: created } = await request<{ chapter: AuthoredChapter }>(
    `/author/stories/${storyId}/chapters`,
    { method: 'POST', headers: readerHeaders(), body: chapter },
  )
  return created
}

export async function updateChapter(
  chapterId: string,
  patch: { title?: string; content?: string },
): Promise<AuthoredChapter> {
  const { chapter } = await request<{ chapter: AuthoredChapter }>(
    `/author/chapters/${chapterId}`,
    { method: 'PATCH', headers: readerHeaders(), body: patch },
  )
  return chapter
}

/** Returns what is left, renumbered — the delete closes the gap it leaves. */
export async function deleteChapter(
  chapterId: string,
): Promise<AuthoredChapter[]> {
  const { chapters } = await request<{ chapters: AuthoredChapter[] }>(
    `/author/chapters/${chapterId}`,
    { method: 'DELETE', headers: readerHeaders() },
  )
  return chapters
}

/** `chapterIds` must list every chapter of the story exactly once. */
export async function reorderChapters(
  storyId: string,
  chapterIds: string[],
): Promise<AuthoredChapter[]> {
  const { chapters } = await request<{ chapters: AuthoredChapter[] }>(
    `/author/stories/${storyId}/chapters/reorder`,
    { method: 'POST', headers: readerHeaders(), body: { chapterIds } },
  )
  return chapters
}

export async function publishChapter(
  chapterId: string,
): Promise<AuthoredChapter> {
  const { chapter } = await request<{ chapter: AuthoredChapter }>(
    `/author/chapters/${chapterId}/publish`,
    { method: 'POST', headers: readerHeaders() },
  )
  return chapter
}

export async function unpublishChapter(
  chapterId: string,
): Promise<AuthoredChapter> {
  const { chapter } = await request<{ chapter: AuthoredChapter }>(
    `/author/chapters/${chapterId}/unpublish`,
    { method: 'POST', headers: readerHeaders() },
  )
  return chapter
}

/* Multimedia ------------------------------------------------------------- */

export async function addMultimedia(
  chapterId: string,
  media: { type: AuthoredMedia['type']; url: string; displayOrder?: number },
): Promise<AuthoredMedia> {
  const { multimedia } = await request<{ multimedia: AuthoredMedia }>(
    `/author/chapters/${chapterId}/multimedia`,
    { method: 'POST', headers: readerHeaders(), body: media },
  )
  return multimedia
}

export function removeMultimedia(mediaId: string): Promise<void> {
  return request<void>(`/author/multimedia/${mediaId}`, {
    method: 'DELETE',
    headers: readerHeaders(),
  })
}
