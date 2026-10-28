/**
 * Finds a cited passage in a rendered chapter.
 *
 * An Ask This Book citation carries a quote: an excerpt of the passage the
 * answer drew on, whitespace flattened, headings and bold unwrapped, cut to
 * a couple of hundred characters around the question's words
 * (`excerptOf` in the API). It is the author's words, so it is in the page —
 * but not as one string. The excerpt may start mid-paragraph, cross a
 * paragraph break that flattening turned into a space, and keep an `*` the
 * renderer turned into italics.
 *
 * So this matches on **runs of words**, not the whole quote: overlapping
 * six-word windows of the quote, looked for in each block's text. Six words
 * is short enough that a quote crossing two paragraphs still has whole
 * windows inside each.
 *
 * And it is **one stretch of text**, because the quote is. Fiction repeats
 * itself — a refrain, a paragraph that opens like the last — so "every block
 * holding a window" can mark half a chapter. Instead the passage is the block
 * holding the most windows, extended to a neighbour only while that neighbour
 * holds a window the stretch does not already have.
 */

const WINDOW = 6
const STEP = 3

/** Lowercased, emphasis marks dropped, typographic quotes straightened. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[*_`]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The word runs a quote is found by. */
export function probesOf(quote: string): string[] {
  const words = normalise(quote).split(' ').filter(Boolean)
  // The excerpt's last word may be cut short; its first may be too.
  const inner = words.length > WINDOW + 2 ? words.slice(1, -1) : words
  if (inner.length <= WINDOW) return inner.length > 0 ? [inner.join(' ')] : []

  const probes: string[] = []
  for (let start = 0; start + WINDOW <= inner.length; start += STEP) {
    probes.push(inner.slice(start, start + WINDOW).join(' '))
  }
  return probes
}

/**
 * The blocks of `container` that hold part of `quote`, in document order.
 * Empty when it cannot be found — the chapter changed since it was indexed,
 * or the quote fell inside markup this does not read — and the caller then
 * simply leaves the reader at the chapter.
 */
export function findPassage(container: HTMLElement, quote: string): HTMLElement[] {
  const probes = probesOf(quote)
  if (probes.length === 0) return []

  const blocks = [...container.querySelectorAll<HTMLElement>('p, li, h1, h2, h3, h4, h5, h6')]
  const hits = blocks.map((block) => {
    const text = normalise(block.textContent ?? '')
    return new Set(probes.filter((probe) => text.includes(probe)))
  })

  let best = -1
  hits.forEach((found, index) => {
    if (found.size > 0 && (best === -1 || found.size > hits[best]!.size)) best = index
  })
  if (best === -1) return []

  const covered = new Set(hits[best])
  const adds = (index: number) =>
    index >= 0 && index < hits.length && [...hits[index]!].some((probe) => !covered.has(probe))
  const take = (index: number) => {
    for (const probe of hits[index]!) covered.add(probe)
  }

  let first = best
  let last = best
  for (;;) {
    if (adds(last + 1)) take(++last)
    else if (adds(first - 1)) take(--first)
    else break
  }

  return blocks.slice(first, last + 1)
}
