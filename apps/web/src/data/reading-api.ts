/**
 * Reading progress data access.
 *
 * Split out of `stories-api.ts` rather than added to it: everything here needs
 * a reader, while every story read works signed out too, and keeping the two
 * apart means nothing in the reader-facing catalogue accidentally depends on a
 * session.
 */

import { request } from '../lib/api-client'
import type { ContinueEntry, ReadingProgress } from '../types/stories'

export interface ProgressInput {
  storyId: string
  chapterId: string
  /** Character offset into the chapter; the API clamps it to the real length. */
  offset: number
}

export interface SavedProgress {
  progress: ReadingProgress
  /** The reader's streak after this save, so the UI can reflect it at once. */
  readingStreak: number
}

/**
 * Saves a resume point. Called on a debounced scroll, so it is idempotent and
 * safe to fire repeatedly: the API upserts one row per story per reader.
 */
export async function saveProgress(
  input: ProgressInput,
): Promise<SavedProgress> {
  return request<SavedProgress>('/reading/progress', {
    method: 'PUT',
    body: input,
  })
}

/** Most recently read stories first, each with its resume target. */
export async function getContinueReading(
  limit?: number,
): Promise<ContinueEntry[]> {
  const { entries } = await request<{ entries: ContinueEntry[] }>(
    '/reading/continue',
    {
      query: { limit: limit === undefined ? undefined : String(limit) },
    },
  )
  return entries
}

/** The reader's position in one story, or null when there is none saved. */
export async function getProgress(
  storyId: string,
): Promise<ReadingProgress | null> {
  const { progress } = await request<{ progress: ReadingProgress | null }>(
    `/reading/progress/${encodeURIComponent(storyId)}`,
  )
  return progress
}

export async function clearProgress(storyId: string): Promise<void> {
  await request<void>(`/reading/progress/${encodeURIComponent(storyId)}`, {
    method: 'DELETE',
  })
}
