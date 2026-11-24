/**
 * The paragraphs of a chapter a reader can comment on, and the rendered
 * blocks that show them.
 *
 * A paragraph comment is addressed by where its paragraph's line starts in
 * the chapter source, so the reader has to know which rendered block is which
 * line. `lib/chapter-markdown.tsx` draws one block per non-blank line of a
 * prose run -- a paragraph, a list item or a block quote -- plus headings and
 * attachments, which take no comments. `commentableParagraphs` lists those
 * lines with their offsets by the renderer's own rules, and
 * `services/paragraph-comments.ts` in the API applies the same rules to check
 * what is posted; the two copies must agree.
 *
 * Pairing is by order, not by searching for text: the n-th commentable block
 * on the page is the n-th commentable line, which is right even for a line
 * that appears twice. Each pair is still checked against its text, and the
 * whole chapter is left without paragraph comments when the counts differ, so
 * a renderer change that broke the agreement shows up as missing markers
 * rather than comments on the wrong paragraph.
 */

export interface ChapterParagraph {
  /** Where the line begins in the chapter source. */
  start: number
  end: number
  /** The line as written, trailing whitespace removed. */
  text: string
}

/** A run that is nothing but an attachment token renders as the attachment. */
const MEDIA_TOKEN = /^\[media:[\w-]+\]$/

/**
 * Every line a reader can comment on, in reading order. Runs split on blank
 * lines and trimmed, as `paragraphsOf` in `types/stories.ts` does, so the
 * runs are the renderer's.
 */
export function commentableParagraphs(content: string): ChapterParagraph[] {
  const runs: Array<{ start: number; end: number }> = []
  let runStart = 0
  for (const separator of content.matchAll(/\n{2,}/g)) {
    runs.push({ start: runStart, end: separator.index })
    runStart = separator.index + separator[0].length
  }
  runs.push({ start: runStart, end: content.length })

  const paragraphs: ChapterParagraph[] = []
  for (const run of runs) {
    const raw = content.slice(run.start, run.end)
    const trimmed = raw.trim()
    if (trimmed.length === 0 || MEDIA_TOKEN.test(trimmed)) continue

    let offset = run.start + (raw.length - raw.trimStart().length)
    for (const rawLine of trimmed.split('\n')) {
      const line = rawLine.trimEnd()
      const heading = line.startsWith('# ') || line.startsWith('## ')
      if (line.trim().length > 0 && !heading) {
        paragraphs.push({ start: offset, end: offset + line.length, text: line })
      }
      offset += rawLine.length + 1
    }
  }
  return paragraphs
}

/** What a reader sees of some text: emphasis markers out, whitespace collapsed. */
function seen(text: string): string {
  return text.replace(/[*_]/g, '').replace(/\s+/g, ' ').trim()
}

/** A source line as the renderer draws it: block quote and list markers off. */
function drawn(line: string): string {
  return line.startsWith('> ') || line.startsWith('- ') ? line.slice(2) : line
}

export interface ParagraphBlock extends ChapterParagraph {
  element: HTMLElement
}

/**
 * The prose's commentable blocks, each with the source paragraph it shows.
 * Empty when the page and the source disagree on how many there are.
 */
export function paragraphBlocks(prose: HTMLElement, content: string): ParagraphBlock[] {
  const elements = [
    ...prose.querySelectorAll<HTMLElement>(
      ':scope > p, :scope > blockquote, :scope > ul > li',
    ),
  ]
  const paragraphs = commentableParagraphs(content)
  if (elements.length !== paragraphs.length) return []

  return elements.flatMap((element, index) => {
    const paragraph = paragraphs[index]!
    return seen(element.textContent ?? '') === seen(drawn(paragraph.text))
      ? [{ ...paragraph, element }]
      : []
  })
}
