import { Fragment, type ReactNode } from 'react'
import { ChapterAttachment } from '../components/story/ChapterAttachment'
import { chapterBlocks, withoutMediaTokens } from './chapter-media'
import type { ChapterMedia } from '../types/stories'

/**
 * How a chapter's text becomes what a reader sees.
 *
 * One renderer for the reader and for the editor's preview, for the same
 * reason `chapter-media.ts` is one module: a preview that renders `# Chapter
 * one` as a heading, over a reader that renders it as a line beginning with a
 * hash, is worse than no preview. This used to live under `pages/author/` and
 * only the preview called it, which is exactly how the two drifted apart.
 *
 * Deliberately builds React elements rather than setting innerHTML, so author
 * text can never inject markup. Supports headings, blockquotes, bullet lists,
 * attachments, and inline bold/italic — the set the editor's toolbar and its
 * formatting hint offer, and no more.
 */

/** Bold and italic, the only spans that mean anything inside a line. */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*)/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  let index = 0

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index))

    const token = match[0]
    const key = `${keyPrefix}-i${index}`
    index += 1

    if (token.startsWith('**')) nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    else nodes.push(<em key={key}>{token.slice(1, -1)}</em>)

    lastIndex = match.index + token.length
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
  return nodes
}

/**
 * One run of prose — everything between two blank lines — as block elements.
 *
 * Line by line rather than by paragraph, because a heading is a line: an
 * author who writes a heading and the sentence under it without a blank
 * between them means two blocks, and that is what the editor's preview has
 * always shown them.
 */
function prose(text: string, keyPrefix: string): ReactNode[] {
  const blocks: ReactNode[] = []
  let listBuffer: string[] = []

  function flushList() {
    if (listBuffer.length === 0) return
    blocks.push(
      <ul key={`${keyPrefix}-ul${blocks.length}`}>
        {listBuffer.map((item, index) => (
          <li key={index}>{inline(item, `${keyPrefix}-l${blocks.length}-${index}`)}</li>
        ))}
      </ul>,
    )
    listBuffer = []
  }

  text.split('\n').forEach((raw, lineIndex) => {
    // Trailing space only: a line's leading space is the author's, and
    // trimming it would silently turn stray indentation into a heading.
    const line = raw.trimEnd()
    const key = `${keyPrefix}-${lineIndex}`

    if (line.trim().length === 0) {
      flushList()
      return
    }

    if (line.startsWith('## ')) {
      flushList()
      blocks.push(<h3 key={key}>{inline(line.slice(3), key)}</h3>)
      return
    }

    if (line.startsWith('# ')) {
      flushList()
      blocks.push(<h2 key={key}>{inline(line.slice(2), key)}</h2>)
      return
    }

    if (line.startsWith('> ')) {
      flushList()
      blocks.push(<blockquote key={key}>{inline(line.slice(2), key)}</blockquote>)
      return
    }

    if (line.startsWith('- ')) {
      listBuffer.push(line.slice(2))
      return
    }

    flushList()
    blocks.push(<p key={key}>{inline(line, key)}</p>)
  })

  flushList()
  return blocks
}

/**
 * The chapter, rendered: prose and attachments in reading order.
 *
 * Where the attachments go is `chapterBlocks`' decision, not this module's —
 * it owns what a `[media:…]` token means, including the ones whose row is gone
 * and the ones the prose never places.
 *
 * `hue` tints the backdrop behind an unplayed video, and only the reader knows
 * the story's genre, so it is passed in rather than read here.
 */
export function renderChapter(
  content: string,
  media: readonly ChapterMedia[] = [],
  hue?: number,
): ReactNode[] {
  return chapterBlocks(content, media).map((block) =>
    block.kind === 'media' ? (
      <ChapterAttachment key={block.key} item={block.item} hue={hue} />
    ) : (
      <Fragment key={block.key}>{prose(block.text, block.key)}</Fragment>
    ),
  )
}

/** Words of prose, with the markup and the attachment tokens taken out. */
export function countWords(source: string): number {
  const text = withoutMediaTokens(source)
    .replace(/[#>*-]/g, ' ')
    .trim()
  return text.length === 0 ? 0 : text.split(/\s+/).length
}
