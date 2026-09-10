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
  genres: Array<{ hue: number }>
  author: { displayName?: string | null; username?: string }
}

interface StoryCoverProps {
  story: CoverStory
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  className?: string
}

/**
 * Generated cover art. Scribe has no uploaded artwork yet and stock imagery
 * would misrepresent real books, so each cover is composed from the story's
 * own title, author and primary genre — deterministic and unique per story.
 */
export function StoryCover({ story, size = 'md', className }: StoryCoverProps) {
  const hue = story.genres[0]?.hue ?? 268
  const art = coverArt(story.id, hue)

  return (
    <div
      className={cn('cover', `cover--${size}`, `cover--v${art.variant}`, className)}
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
    </div>
  )
}
