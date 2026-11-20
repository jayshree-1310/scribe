/**
 * Finding a saved highlight on the rendered page, as a DOM `Range`.
 *
 * The inverse of `lib/chapter-selection.ts`. That module takes what a reader
 * selected and finds it in the chapter *source*; this takes a quote from the
 * source and finds it in what the renderer drew. The two disagree in the same
 * ways in both directions -- the renderer drops `**`/`*` markers, collapses a
 * newline inside a paragraph, and puts nothing between two blocks -- so the
 * match is on the quote's words with any whitespace between them, after the
 * markers are taken out.
 *
 * Ranges rather than wrapping the passage in `<mark>`: the prose is React's,
 * and an element inserted under it is one React does not know about and will
 * trip over on the next render. A `Range` is painted with the CSS Custom
 * Highlight API (`CSS.highlights`), which changes nothing in the document.
 */

/** Characters that mean something to a regular expression. */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Elements that end a run of text: a reader sees a break between two of them. */
const BLOCKS = new Set([
  'P', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'DIV', 'FIGURE', 'FIGCAPTION',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
])

function blockOf(node: Node, container: Node): Node {
  let current: Node | null = node.parentNode
  while (current && current !== container) {
    if (current instanceof Element && BLOCKS.has(current.tagName)) return current
    current = current.parentNode
  }
  return container
}

interface TextIndex {
  /** Every text node's text, with a newline wherever a block ends. */
  text: string
  /** Each node and where its text starts in `text`. */
  nodes: Array<{ node: Text; start: number }>
}

/**
 * The container's text, flattened, remembering which node each character came
 * from. The newlines between blocks are the index's own -- they map to no
 * node -- and are what stops "midnight." and "She" in two paragraphs reading
 * as "midnight.She".
 */
export function indexText(container: HTMLElement): TextIndex {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const nodes: TextIndex['nodes'] = []
  let text = ''
  let lastBlock: Node | null = null

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const block = blockOf(node, container)
    if (lastBlock !== null && block !== lastBlock) text += '\n'
    lastBlock = block

    nodes.push({ node: node as Text, start: text.length })
    text += node.nodeValue ?? ''
  }

  return { text, nodes }
}

/** The node and offset holding `position`, leaning forward or back at a seam. */
function pointAt(
  index: TextIndex,
  position: number,
  side: 'start' | 'end',
): { node: Text; offset: number } | null {
  for (const entry of index.nodes) {
    const length = entry.node.nodeValue?.length ?? 0
    const inside =
      side === 'start'
        ? position >= entry.start && position < entry.start + length
        : position > entry.start && position <= entry.start + length
    if (inside) return { node: entry.node, offset: position - entry.start }
  }
  return null
}

/**
 * The rendered range showing `quote`, or null when the page does not show it.
 *
 * `sourceStart` and `sourceLength` place it: a phrase can occur several times
 * in a chapter, and the one the reader highlighted is the one nearest its
 * stored place, scaled from source characters to rendered ones. The two grow
 * together, so nearest-after-scaling picks the right repeat.
 */
export function rangeForQuote(
  index: TextIndex,
  quote: string,
  sourceStart: number,
  sourceLength: number,
): Range | null {
  const words = quote.replace(/[*_]/g, '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return null

  const pattern = new RegExp(words.map(escapeRegex).join('\\s+'), 'gu')
  const near = sourceLength > 0 ? (sourceStart * index.text.length) / sourceLength : 0

  let best: { start: number; end: number } | null = null
  for (const match of index.text.matchAll(pattern)) {
    if (best === null || Math.abs(match.index - near) < Math.abs(best.start - near)) {
      best = { start: match.index, end: match.index + match[0].length }
    }
  }
  if (best === null) return null

  const from = pointAt(index, best.start, 'start')
  const to = pointAt(index, best.end, 'end')
  if (!from || !to) return null

  const range = document.createRange()
  range.setStart(from.node, from.offset)
  range.setEnd(to.node, to.offset)
  return range
}

/** Whether a point on screen falls on the range's text. */
export function rangeContainsPoint(range: Range, x: number, y: number): boolean {
  for (const rect of range.getClientRects()) {
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true
  }
  return false
}

/**
 * Paints ranges under a name `::highlight(name)` styles. A no-op where the
 * browser has no Custom Highlight API: the highlights list still works there,
 * the page just is not marked.
 */
export function paintHighlights(name: string, ranges: Range[]): void {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return
  if (ranges.length === 0) CSS.highlights.delete(name)
  else CSS.highlights.set(name, new Highlight(...ranges))
}
