import type { CSSProperties } from 'react'
import { cn } from '../../lib/cn'
import { coverArt } from '../../lib/cover'
import { authorName, type Book } from '../../types/books'

interface BookCoverProps {
  book: Pick<Book, 'id' | 'title' | 'coverUrl' | 'genres' | 'author'>
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  className?: string
}

/**
 * A book's cover — the same frame `StoryCover` draws, over the same
 * `content.Story` table. Artwork where the edition has some, generated art
 * from the title, author and primary genre where it does not, so a catalogue
 * with patchy imagery still reads as a shelf rather than a list of grey boxes.
 */
export function BookCover({ book, size = 'md', className }: BookCoverProps) {
  const hue = book.genres[0]?.hue ?? 268
  const art = coverArt(book.id, hue)

  return (
    <div
      className={cn(
        'cover',
        `cover--${size}`,
        book.coverUrl ? 'cover--photo' : `cover--v${art.variant}`,
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
      {book.coverUrl ? (
        <img className="cover__art" src={book.coverUrl} alt="" loading="lazy" />
      ) : (
        <span className="cover__rule" />
      )}
      <span className="cover__title">{book.title}</span>
      <span className="cover__author">{authorName(book.author)}</span>
    </div>
  )
}
