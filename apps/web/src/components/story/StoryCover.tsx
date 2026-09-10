import type { CSSProperties } from 'react'
import { cn } from '../../lib/cn'
import { coverArt } from '../../lib/cover'

/**
 * Only what the art needs. Structural rather than tied to one story type,
 * because covers are drawn for both the mock stories the app still reads and
 * the real ones from `types/stories.ts` — whose `displayName` can be null.
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
 * Both variants — uploaded artwork and generated art — are the same frame in
 * the same palette, drawn from the story's primary genre hue: art sits above
 * the title and author rather than replacing them, so a shelf mixing the two
 * still reads as a shelf. Uploaded artwork is never stretched; it fills the
 * panel and crops, because an author's 4:3 photograph distorted to 2:3 looks
 * worse than a crop of it.
 */
export function StoryCover({ story, size = 'md', className }: StoryCoverProps) {
  const hue = story.genres[0]?.hue ?? 268
  const art = coverArt(story.id, hue)

  return (
    <div
      className={cn(
        'cover',
        `cover--${size}`,
        story.coverUrl ? 'cover--photo' : `cover--v${art.variant}`,
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
      {story.coverUrl ? (
        <img className="cover__art" src={story.coverUrl} alt="" loading="lazy" />
      ) : (
        <span className="cover__rule" />
      )}
      <span className="cover__title">{story.title}</span>
      <span className="cover__author">
        {story.author.displayName || story.author.username}
      </span>
    </div>
  )
}
