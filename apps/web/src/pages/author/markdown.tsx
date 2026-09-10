import type { ReactNode } from 'react'
import { ChapterAttachment } from '../../components/story/ChapterAttachment'
import { withoutMediaTokens } from '../../lib/chapter-media'
import type { ChapterMedia } from '../../types/stories'

/**
 * Minimal block + inline renderer for the chapter editor's preview.
 *
 * Deliberately builds React elements rather than setting innerHTML, so author
 * text can never inject markup. Supports headings, blockquotes, bullet lists,
 * attachments, and inline bold/italic.
 */

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
 * A `[media:<id>]` line. Matched here as well as in `lib/chapter-media.ts`
 * because this renderer works line by line rather than by paragraph — but the
 * meaning of the token, and what happens to one whose row is gone, is that
 * module's decision and this follows it.
 */
const MEDIA_TOKEN = /^\[media:([\w-]+)\]$/

/**
 * Renders the chapter as the reader will see it, attachments included, so the
 * preview is a preview rather than a description of one.
 */
export function renderMarkdown(
  source: string,
  media: readonly ChapterMedia[] = [],
): ReactNode[] {
  const byId = new Map(media.map((item) => [item.id, item]))
  const placed = new Set<string>()

  const blocks: ReactNode[] = []
  const lines = source.split('\n')
  let listBuffer: string[] = []

  function flushList() {
    if (listBuffer.length === 0) return
    blocks.push(
      <ul key={`list-${blocks.length}`}>
        {listBuffer.map((item, index) => (
          <li key={index}>{inline(item, `l${blocks.length}-${index}`)}</li>
        ))}
      </ul>,
    )
    listBuffer = []
  }

  lines.forEach((raw, lineIndex) => {
    const line = raw.trimEnd()
    const key = `b${lineIndex}`

    if (line.trim().length === 0) {
      flushList()
      return
    }

    const token = MEDIA_TOKEN.exec(line.trim())
    if (token) {
      flushList()

      const item = byId.get(token[1]!)
      // A token whose attachment is gone renders as nothing, not as plumbing.
      if (!item) return

      placed.add(item.id)
      blocks.push(<ChapterAttachment key={key} item={item} />)
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

  // Same fallback as the reader: an attachment the prose never places follows
  // the text, so nothing the author uploaded is invisible here either.
  for (const item of media) {
    if (!placed.has(item.id)) {
      blocks.push(<ChapterAttachment key={`t-${item.id}`} item={item} />)
    }
  }

  return blocks
}

export function countWords(source: string): number {
  const text = withoutMediaTokens(source)
    .replace(/[#>*-]/g, ' ')
    .trim()
  return text.length === 0 ? 0 : text.split(/\s+/).length
}
