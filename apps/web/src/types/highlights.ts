/**
 * A passage a reader highlighted, as `GET /api/reading/highlights` returns it.
 * Mirrors `services/highlights.ts` in the API.
 */
export interface SavedHighlight {
  id: string
  storyId: string
  chapterId: string
  chapterNumber: number
  chapterTitle: string
  /** Where the passage sits in the chapter's current source text. */
  start: number
  end: number
  /** The chapter source between the offsets, emphasis markers included. */
  quote: string
  note: string | null
  /**
   * False once the author has removed the passage. The quote and note are
   * still the reader's to see, but there is nothing on the page to paint.
   */
  found: boolean
  createdAt: string
  updatedAt: string
}

/** Longest private note; the API refuses more. */
export const HIGHLIGHT_NOTE_LIMIT = 1000

/** The quote as a reader sees it: emphasis markers out, whitespace collapsed. */
export function plainQuote(quote: string): string {
  return quote.replace(/[*_]/g, '').replace(/\s+/g, ' ').trim()
}
