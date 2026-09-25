/**
 * Mapping a reader's highlight back onto the chapter's source text.
 *
 * The problem this exists for: `lib/chapter-markdown.tsx` renders `**cold**`
 * as `cold` and drops media tokens entirely, so a character offset into what
 * the reader sees is *not* a character offset into `Chapter.content`. The AI
 * explain endpoint takes offsets into the stored source -- deliberately, so
 * that the only thing it can ever be asked about is published fiction (see
 * `services/ai/explain.ts`) -- which leaves somebody having to bridge the two.
 *
 * The alternative was to thread source offsets through the renderer and out
 * onto every DOM node. That is a real option and a better one for a large
 * document, but it touches a component the editor preview shares and it makes
 * every future formatting feature carry an offset obligation. This module is
 * the cheaper trade: search the source for what the reader highlighted, and be
 * honest when it cannot be found rather than sending the wrong passage.
 *
 * It is deliberately tolerant in two specific ways, because both are the
 * normal case rather than edge cases:
 *
 * - **Whitespace differs.** The DOM collapses a newline inside a paragraph to
 *   a space, so a selection spanning a line break never matches the source
 *   literally.
 * - **Emphasis markers are invisible to the reader.** Selecting "the lamp
 *   cold" over source that reads "the **lamp** cold" must still find it.
 *
 * Both are handled by matching word-by-word with the separators left loose. It
 * cannot handle emphasis *inside* a word (`un**bel**ievable`), which is rare
 * enough to be worth failing on visibly.
 */

/** Characters that mean something to a regular expression. */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Where `selected` sits in `source`, or null when it cannot be placed.
 *
 * `nearRenderedOffset` disambiguates. A phrase can occur several times in a
 * chapter, and the one the reader highlighted is the one nearest to where they
 * are — so the caller passes how far into the rendered prose the selection
 * began, and the closest candidate wins. The two offsets are not equal (the
 * source is always longer) but they grow together, so "closest" is a good
 * enough ordering and a far better one than "first".
 */
export function locateInSource(
  source: string,
  selected: string,
  nearRenderedOffset = 0,
): { start: number; end: number } | null {
  const words = selected.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return null

  /**
   * Word, then any run of whitespace and emphasis markers, then the next word.
   * `[\s*_]+` is what absorbs both a collapsed newline and the asterisks the
   * reader never saw.
   */
  const pattern = new RegExp(words.map(escapeRegex).join('[\\s*_]+'), 'g')

  let best: { start: number; end: number } | null = null
  let bestDistance = Number.POSITIVE_INFINITY

  for (const match of source.matchAll(pattern)) {
    const distance = Math.abs(match.index - nearRenderedOffset)
    if (distance < bestDistance) {
      bestDistance = distance
      best = { start: match.index, end: match.index + match[0].length }
    }
  }

  return best
}

/**
 * How far into `container`'s text the range begins.
 *
 * Used only to disambiguate above, so an approximation is fine: it walks the
 * text nodes and counts what precedes the range's start.
 */
export function renderedOffsetOf(container: Node, range: Range): number {
  const before = range.cloneRange()
  before.selectNodeContents(container)
  before.setEnd(range.startContainer, range.startOffset)
  return before.toString().length
}

export interface ChapterSelection {
  text: string
  start: number
  end: number
}

/**
 * The reader's current selection, resolved against the chapter source.
 *
 * Returns null for anything that is not a usable passage: an empty or
 * collapsed selection, one that strayed outside the prose (the comments below
 * it, say), or one this module could not place in the source. The caller shows
 * no menu at all in every one of those cases, which is why they share a return
 * value — offering an action that cannot work is worse than offering none.
 */
export function readSelection(
  container: HTMLElement | null,
  source: string,
): ChapterSelection | null {
  if (!container) return null

  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null
  }

  const range = selection.getRangeAt(0)
  // Both ends inside the prose. A selection that began in the chapter and
  // ended in the comment box is not a passage.
  if (
    !container.contains(range.startContainer) ||
    !container.contains(range.endContainer)
  ) {
    return null
  }

  const text = selection.toString().trim()
  if (text.length === 0) return null

  const located = locateInSource(source, text, renderedOffsetOf(container, range))
  if (!located) return null

  return { text, start: located.start, end: located.end }
}
