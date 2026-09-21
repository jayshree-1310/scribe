import type { CSSProperties } from 'react'
import { cn } from '../../lib/cn'
import { coverArt } from '../../lib/cover'

/**
 * Only what the art needs. Structural rather than tied to one story type,
 * because covers are drawn for a `Story`, a catalogue `Book` and the reduced
 * rows the author pages carry — which agree on these fields and little else.
 */
interface CoverStory {
  id: string
  title: string
  /** Uploaded artwork, when the author has any. */
  coverUrl?: string | null
  genres: Array<{ hue: number }>
  author: { displayName?: string | null; username?: string }
}

interface StoryCoverProps {
  story: CoverStory
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  className?: string
}

/**
 * A story's cover.
 *
 * Uploaded artwork takes the whole frame: real cover art already carries its
 * own title, so setting ours under it prints the name twice. The title and
 * author are the fallback — they *are* the art on a generated cover, drawn in
 * the story's primary genre hue so a shelf mixing the two still reads as a
 * shelf. Uploaded artwork is never stretched; it fills the panel and crops,
 * because an author's 4:3 photograph distorted to 2:3 looks worse than a crop
 * of it.
 *
 * The generated cover is always rendered and the artwork laid over it, rather
 * than the two being branches of a ternary -- the same shape `Avatar` uses for
 * a monogram, and for the same reason. A `coverUrl` is a promise about a file
 * that may not be kept: storage moves, an object is deleted, the reader is
 * offline. Branching on the column meant that a cover which 404s left a
 * coloured panel with no title on it, which is worse than either outcome the
 * design intended.
 */
export function StoryCover({ story, size = 'md', className }: StoryCoverProps) {
  const hue = story.genres[0]?.hue ?? 268
  const art = coverArt(story.id, hue)

  return (
    <div
      className={cn(
        'cover',
        `cover--${size}`,
        `cover--v${art.variant}`,
        className,
      )}
      style={
        {
          '--cover-bg': art.background,
          '--cover-ink': art.ink,
          '--cover-accent': art.accent,
        } as CSSProperties
      }
      aria-hidden="true"
    >
      <span className="cover__spine" />
      <span className="cover__rule" />
      <span className="cover__title">{story.title}</span>
      <span className="cover__author">
        {story.author.displayName || story.author.username}
      </span>
      {story.coverUrl ? (
        <img className="cover__art" src={story.coverUrl} alt="" loading="lazy" />
      ) : null}
    </div>
  )
}
