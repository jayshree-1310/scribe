import { Children, useRef } from 'react'
import type { ReactNode } from 'react'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'

interface StoryShelfProps {
  children: ReactNode
  /** Accessible name, usually the section heading. */
  label: string
}

/**
 * Horizontal shelf of cards: native swipe with snap on touch, arrow buttons on
 * pointer devices. Keeps rows of covers scannable without a carousel library.
 */
export function StoryShelf({ children, label }: StoryShelfProps) {
  const trackRef = useRef<HTMLUListElement>(null)

  /*
   * Nothing to scroll: the track would collapse to no height while the
   * controls, which hang above it, stayed behind over the section heading.
   * A caller with an empty list wants its own empty state, not bare arrows.
   */
  if (Children.count(children) === 0) return null

  function scrollBy(direction: 1 | -1) {
    const track = trackRef.current
    if (!track) return
    track.scrollBy({ left: direction * track.clientWidth * 0.8, behavior: 'smooth' })
  }

  return (
    <div className="shelf">
      <ul className="shelf__track" ref={trackRef} aria-label={label}>
        {children}
      </ul>

      <div className="shelf__controls" aria-hidden="true">
        <Button
          variant="secondary"
          size="sm"
          iconOnly
          aria-label={`Scroll ${label} left`}
          onClick={() => scrollBy(-1)}
          startIcon={<Icon name="chevron-left" />}
        />
        <Button
          variant="secondary"
          size="sm"
          iconOnly
          aria-label={`Scroll ${label} right`}
          onClick={() => scrollBy(1)}
          startIcon={<Icon name="chevron-right" />}
        />
      </div>
    </div>
  )
}
