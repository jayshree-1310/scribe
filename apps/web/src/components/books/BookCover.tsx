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
 * A book's cover.
 *
 * Uses the artwork when a book has some; otherwise composes one from the
 * book's own title, author and primary genre through the same `coverArt`
 * helper the rest of Scribe uses, so a catalogue with no imagery still reads
 * as a shelf rather than a list of grey boxes.
 */
export function BookCover({ book, size = 'md', className }: BookCoverProps) {
  const hue = book.genres[0]?.hue ?? 268
  const art = coverArt(book.id, hue)

  if (book.coverUrl) {
    return (
      <img
        className={cn('cover', 'cover--image', `cover--${size}`, className)}
        src={book.coverUrl}
        alt=""
        loading="lazy"
      />
    )
  }

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
      <span className="cover__title">{book.title}</span>
      <span className="cover__author">{authorName(book.author)}</span>
    </div>
  )
}
