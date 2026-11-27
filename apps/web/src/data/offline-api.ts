/**
 * The requests behind offline reading.
 *
 * Saving a story fetches it and every chapter, and so does each later check
 * for new and edited chapters. None of that is reading, so these carry
 * `X-Scribe-Offline`, which the API honours by recording no story view and
 * no chapter read (`OFFLINE_SAVE_HEADER` in `apps/api/src/routes/stories.ts`).
 * A saved chapter is counted when the reader opens it, through `recordReads`.
 *
 * Kept apart from `stories-api.ts` because those reads fall back to the saved
 * copy when the network fails, and these must not: a check that "succeeded"
 * by reading the copy it is checking would prove nothing.
 */

import { request } from '../lib/api-client'
import type { Chapter, ChapterSummary, StoryDetail } from '../types/stories'

const UNCOUNTED = { 'X-Scribe-Offline': '1' }

export async function fetchStoryForCopy(slugOrId: string): Promise<StoryDetail> {
  const { story } = await request<{ story: StoryDetail }>(
    `/stories/${encodeURIComponent(slugOrId)}`,
    { headers: UNCOUNTED },
  )
  return story
}

export async function fetchChaptersForCopy(slugOrId: string): Promise<ChapterSummary[]> {
  const { chapters } = await request<{ chapters: ChapterSummary[] }>(
    `/stories/${encodeURIComponent(slugOrId)}/chapters`,
    { headers: UNCOUNTED },
  )
  return chapters
}

export async function fetchChapterForCopy(slugOrId: string, number: number): Promise<Chapter> {
  const { chapter } = await request<{ chapter: Chapter }>(
    `/stories/${encodeURIComponent(slugOrId)}/chapters/${number}`,
    { headers: UNCOUNTED },
  )
  return chapter
}

/** The API takes this many at a time (`MAX_SAVED_READS`). */
export const READS_PER_REQUEST = 50

/** Chapters the reader opened from a saved copy, counted now they can be. */
export async function recordReads(chapterIds: string[]): Promise<number> {
  const { recorded } = await request<{ recorded: number }>('/reading/reads', {
    method: 'POST',
    body: { chapterIds },
  })
  return recorded
}
