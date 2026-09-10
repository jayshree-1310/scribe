/**
 * Where a chapter's attachments sit in its prose.
 *
 * An attachment is a `content.Multimedia` row, and the chapter's text places it
 * with a `[media:<id>]` token on a line of its own. The token is a real
 * reference: it names the row, so the reader resolves it to the stored file
 * rather than rendering a caption and hoping.
 *
 * One module because two renderers have to agree — the reader and the editor's
 * preview — and a token that means one thing in the preview and another in the
 * published chapter is worse than no preview.
 */

import { paragraphsOf } from '../types/stories'

/** The token to write into the prose to place an attachment. */
export function mediaToken(id: string): string {
  return `[media:${id}]`
}

/**
 * Matches a whole paragraph that is nothing but a token.
 *
 * Deliberately not an inline match: an attachment is a block, and a token in
 * the middle of a sentence has nowhere to render that would not break the
 * paragraph around it.
 */
const TOKEN = /^\[media:([\w-]+)\]$/

/** Strips the tokens, so a word count is a count of words. */
export function withoutMediaTokens(content: string): string {
  return content.replace(/^\[media:[\w-]+\]$/gm, '')
}

/**
 * Drops the token that placed one attachment.
 *
 * Detaching leaves the token pointing at a row that is gone. It would render
 * as nothing either way, but leaving it means an author who opens the chapter
 * later finds `[media:…]` in their own prose with nothing to explain it.
 */
export function removeMediaToken(content: string, id: string): string {
  const token = mediaToken(id).replace(/[[\]]/g, '\\$&')

  return content
    .replace(new RegExp(`\\n*^${token}$\\n*`, 'm'), '\n\n')
    .replace(/^\s+|\s+$/g, '')
}

export interface ProseBlock {
  kind: 'prose'
  text: string
  key: string
}

export interface MediaBlock<T> {
  kind: 'media'
  item: T
  key: string
}

export type ChapterBlock<T> = ProseBlock | MediaBlock<T>

/**
 * The chapter as a sequence of paragraphs and attachments, in reading order.
 *
 * Two rules worth knowing:
 *
 * - A token whose row is gone renders as nothing rather than as literal
 *   `[media:…]` text. Detaching a file leaves the token behind in prose the
 *   author may not have touched since, and showing them the plumbing is worse
 *   than showing them a gap.
 * - An attachment the prose never places goes after the text, in
 *   `displayOrder`. That is where every attachment used to go, so old chapters
 *   keep reading the way they did, and a file uploaded while the token was
 *   still unsaved is visible rather than lost.
 */
export function chapterBlocks<T extends { id: string }>(
  content: string,
  media: readonly T[],
): ChapterBlock<T>[] {
  const byId = new Map(media.map((item) => [item.id, item]))
  const placed = new Set<string>()
  const blocks: ChapterBlock<T>[] = []

  paragraphsOf(content).forEach((paragraph, index) => {
    const match = TOKEN.exec(paragraph)

    if (match) {
      const item = byId.get(match[1]!)
      if (!item) return

      placed.add(item.id)
      blocks.push({ kind: 'media', item, key: `m${index}` })
      return
    }

    blocks.push({ kind: 'prose', text: paragraph, key: `p${index}` })
  })

  for (const item of media) {
    if (!placed.has(item.id)) {
      blocks.push({ kind: 'media', item, key: `t${item.id}` })
    }
  }

  return blocks
}

/**
 * Inserts a token at `offset`, on its own paragraph.
 *
 * The blank lines are what make it a block: dropped into the middle of a
 * sentence the token splits the paragraph, which is what "here" means when the
 * caret was mid-sentence.
 */
export function insertMediaToken(
  content: string,
  offset: number,
  id: string,
): string {
  const at = Math.max(0, Math.min(offset, content.length))
  const before = content.slice(0, at).replace(/\s+$/, '')
  const after = content.slice(at).replace(/^\s+/, '')

  return [before, mediaToken(id), after]
    .filter((part) => part.length > 0)
    .join('\n\n')
}
