import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderChapter } from './chapter-markdown'
import { commentableParagraphs, paragraphBlocks } from './chapter-paragraphs'

/** Renders a chapter the way the reader does. */
function prose(source: string): HTMLElement {
  const { container } = render(<div>{renderChapter(source, [], 268)}</div>)
  return container.firstElementChild as HTMLElement
}

const CHAPTER = [
  '# The cellar',
  '## Before',
  'The lamp went **cold** at *midnight*.',
  '  She counted the stairs, twice.',
  '',
  '[media:gone-row]',
  '',
  '> Nobody answered.',
  '- One stair',
  '- Two stairs',
  '',
  '',
  '   ### Not a heading, a line with hashes.',
  '',
  'Nobody answered.',
].join('\n')

describe('paragraphBlocks', () => {
  it('pairs every block the renderer draws with the line it came from', () => {
    const blocks = paragraphBlocks(prose(CHAPTER), CHAPTER)
    expect(blocks.map((block) => [block.element.tagName, block.element.textContent])).toEqual([
      ['P', 'The lamp went cold at midnight.'],
      ['P', '  She counted the stairs, twice.'],
      ['BLOCKQUOTE', 'Nobody answered.'],
      ['LI', 'One stair'],
      ['LI', 'Two stairs'],
      ['P', '### Not a heading, a line with hashes.'],
      ['P', 'Nobody answered.'],
    ])
    expect(blocks).toHaveLength(commentableParagraphs(CHAPTER).length)
  })

  it('gives each block the offset of its own line, even a repeated one', () => {
    const blocks = paragraphBlocks(prose(CHAPTER), CHAPTER)
    for (const block of blocks) {
      expect(CHAPTER.slice(block.start, block.end)).toBe(block.text)
    }
    expect(blocks[2]!.start).toBe(CHAPTER.indexOf('> Nobody answered.'))
    expect(blocks[6]!.start).toBe(CHAPTER.lastIndexOf('Nobody answered.'))
  })

  it('offers nothing when the page and the source disagree', () => {
    expect(paragraphBlocks(prose('One.\n\nTwo.'), 'One.\n\nTwo.\n\nThree.')).toEqual([])
  })
})
