import { describe, expect, it } from 'vitest'
import {
  QUOTE_SIZES,
  cardParagraphs,
  chapterLabel,
  ellipsize,
  fitQuote,
  quoteCardAddress,
  quoteCardLink,
  wrapText,
} from './quote-card'

/** Every character half as wide as the type is tall: easy to reason about. */
const measure = (text: string, size: number) => [...text].length * size * 0.5
const at = (size: number) => (text: string) => measure(text, size)

describe('cardParagraphs', () => {
  it('prints what the reader saw, without the markup', () => {
    const quote = [
      'The **lamp** was *cold* by',
      'morning.',
      '',
      '> She did not look back.',
      '- the tide',
      '## Low water',
      '* * *',
      '[media:3f2a-11]',
    ].join('\n')

    expect(cardParagraphs(quote)).toEqual([
      'The lamp was cold by',
      'morning.',
      'She did not look back.',
      'the tide',
      'Low water',
    ])
  })

  it('collapses the whitespace inside a line', () => {
    expect(cardParagraphs('  a   quiet\tharbour  ')).toEqual(['a quiet harbour'])
  })
})

describe('wrapText', () => {
  it('fills each line with as many words as fit', () => {
    // 10px a character, 100px a line: ten characters.
    expect(wrapText('the lamp was lit at dusk', 100, at(20))).toEqual([
      'the lamp',
      'was lit at',
      'dusk',
    ])
  })

  it('breaks a word too wide for any line between characters', () => {
    expect(wrapText('see abcdefghijklmnop', 100, at(20))).toEqual([
      'see',
      'abcdefghij',
      'klmnop',
    ])
  })
})

describe('ellipsize', () => {
  it('leaves text that fits alone', () => {
    expect(ellipsize('The Ferry', 100, at(20))).toBe('The Ferry')
  })

  it('cuts at a word, and drops the punctuation before the ellipsis', () => {
    // Six characters to a line: "Salt, and…" is too long, "Salt,…" loses its comma.
    expect(ellipsize('Salt, and the long road home', 60, at(20))).toBe('Salt…')
  })
})

describe('fitQuote', () => {
  const box = { width: 400, height: 300 }

  it('sets a short line as large as the card allows', () => {
    const layout = fitQuote(['Light the lamp.'], measure, box)

    expect(layout.size).toBe(QUOTE_SIZES.max)
    expect(layout.truncated).toBe(false)
    expect(layout.lines.map((line) => line.text)).toEqual(['Light the', 'lamp.'])
  })

  it('shrinks a longer passage until the whole of it fits', () => {
    // Too long for the largest type, comfortably inside the smallest.
    const passage = 'word '.repeat(20).trim()
    const layout = fitQuote([passage], measure, box)

    expect(layout.size).toBeLessThan(QUOTE_SIZES.max)
    expect(layout.size).toBeGreaterThanOrEqual(QUOTE_SIZES.min)
    expect(layout.truncated).toBe(false)
    expect(layout.height).toBeLessThanOrEqual(box.height)
    expect(layout.lines.map((line) => line.text).join(' ')).toBe(passage)
  })

  it('leaves a gap between paragraphs', () => {
    const one = fitQuote(['a b', 'c d'], measure, box)
    const lines = one.lines.map((line) => line.y)

    expect(lines[1]! - lines[0]!).toBeGreaterThan(one.lineHeight)
  })

  it('cuts a passage too long for the smallest type, and says so', () => {
    const passage = Array.from({ length: 200 }, (_, index) => `w${index}.`).join(' ')
    const layout = fitQuote([passage], measure, box)

    expect(layout.size).toBe(QUOTE_SIZES.min)
    expect(layout.truncated).toBe(true)
    expect(layout.height).toBeLessThanOrEqual(box.height)

    const last = layout.lines[layout.lines.length - 1]!.text
    expect(last.endsWith('…')).toBe(true)
    // The full stop before the cut goes: "w12…", not "w12.…".
    expect(last).not.toMatch(/\.…$/)
    for (const line of layout.lines) {
      expect(measure(line.text, layout.size)).toBeLessThanOrEqual(box.width)
    }
  })
})

describe('chapterLabel', () => {
  it('names the chapter by number and title', () => {
    expect(chapterLabel(3, 'The Ferry')).toBe('Chapter 3 · The Ferry')
  })

  it('does not repeat a title that is only the number', () => {
    expect(chapterLabel(3, 'Chapter 3')).toBe('Chapter 3')
    expect(chapterLabel(3, 'chapter three')).toBe('Chapter 3')
    expect(chapterLabel(3, '  ')).toBe('Chapter 3')
  })
})

describe('quoteCardLink', () => {
  it('opens the chapter, and is printed without its scheme', () => {
    const link = quoteCardLink('https://scribe.example', 'the-lamplighter', 2)

    expect(link).toBe('https://scribe.example/read/the-lamplighter/2')
    expect(quoteCardAddress(link)).toBe('scribe.example/read/the-lamplighter/2')
  })
})
