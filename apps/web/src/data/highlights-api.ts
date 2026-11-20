/**
 * Highlights and margin notes.
 *
 * A highlight is made from offsets into the stored chapter, never from the
 * selected text: the API cuts the quote out of the chapter itself, the same
 * way "Explain this passage" works. `lib/chapter-selection.ts` produces the
 * offsets. Everything here needs a reader.
 */

import { request } from '../lib/api-client'
import type { SavedHighlight } from '../types/highlights'

/** The reader's highlights in one story, in reading order. */
export async function listHighlights(storyId: string): Promise<SavedHighlight[]> {
  const { highlights } = await request<{ highlights: SavedHighlight[] }>(
    '/reading/highlights',
    { query: { storyId } },
  )
  return highlights
}

export async function createHighlight(input: {
  chapterId: string
  start: number
  end: number
  note?: string | null
}): Promise<SavedHighlight> {
  const { highlight } = await request<{ highlight: SavedHighlight }>(
    '/reading/highlights',
    { method: 'POST', body: input },
  )
  return highlight
}

/** Sets the note, or clears it with null or blank text. */
export async function updateHighlightNote(
  id: string,
  note: string | null,
): Promise<SavedHighlight> {
  const { highlight } = await request<{ highlight: SavedHighlight }>(
    `/reading/highlights/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: { note } },
  )
  return highlight
}

export async function deleteHighlight(id: string): Promise<void> {
  await request<void>(`/reading/highlights/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}
