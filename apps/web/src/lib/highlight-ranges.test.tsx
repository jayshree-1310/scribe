import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderChapter } from './chapter-markdown'
import { locateInSource } from './chapter-selection'
import { indexText, rangeForQuote } from './highlight-ranges'

/** Renders a chapter the way the reader does and indexes its text. */
function rendered(source: string) {
  const { container } = render(<div>{renderChapter(source, [], 268)}</div>)
  const prose = container.firstElementChild as HTMLElement
  return indexText(prose)
}

/** What a highlight made from `selected` would store, then find again. */
function roundTrip(source: string, selected: string, near = 0): string | null {
  const located = locateInSource(source, selected, near)
  if (!located) throw new Error(`"${selected}" is not in the source`)
  const quote = source.slice(located.start, located.end)
  return rangeForQuote(rendered(source), quote, located.start, source.length)?.toString() ?? null
}

describe('rangeForQuote', () => {
  it('finds a quote whose emphasis markers the renderer removed', () => {
    const source = 'The lamp went **cold** at midnight.'
    expect(roundTrip(source, 'lamp went cold')).toBe('lamp went cold')
  })

  it('finds a quote across two paragraphs', () => {
    const source = 'The lamp went cold.\n\nShe counted the stairs.'
    const found = roundTrip(source, 'cold.\nShe counted')
    expect(found?.replace(/\s+/g, ' ')).toBe('cold.She counted')
  })

  it('picks the repeat nearest the stored place', () => {
    const source = 'Again and again.\n\nThe middle.\n\nAgain and again.'
    const index = rendered(source)
    const second = source.lastIndexOf('Again')
    const range = rangeForQuote(index, 'Again', second, source.length)!
    expect(range.startContainer.parentElement?.textContent).toBe('Again and again.')
    expect(range.startContainer).not.toBe(rangeForQuote(index, 'Again', 0, source.length)!.startContainer)
  })

  it('returns null for text the page does not show', () => {
    expect(rangeForQuote(rendered('Nothing here.'), 'something else', 0, 13)).toBeNull()
  })
})
