import type { ReactNode } from 'react'

/**
 * Minimal block + inline renderer for the chapter editor's preview.
 *
 * Deliberately builds React elements rather than setting innerHTML, so author
 * text can never inject markup. Supports headings, blockquotes, bullet lists,
 * media placeholders, and inline bold/italic.
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

const MEDIA_PATTERN = /^\[(image|audio|video):\s*(.*)\]$/i

export function renderMarkdown(source: string): ReactNode[] {
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

    const media = MEDIA_PATTERN.exec(line.trim())
    if (media) {
      flushList()
      blocks.push(
        <p className="preview__media" key={key}>
          {media[1]!.toLowerCase()} — {media[2]}
        </p>,
      )
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

export function countWords(source: string): number {
  const text = source
    .replace(MEDIA_PATTERN, '')
    .replace(/[#>*-]/g, ' ')
    .trim()
  return text.length === 0 ? 0 : text.split(/\s+/).length
}
