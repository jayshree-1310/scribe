import type { CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { cn } from '../../lib/cn'
import { genreChipStyle } from '../../lib/cover'
import { formatCount, formatRating } from '../../lib/format'
import { Icon } from '../ui/Icon'
import { Stars } from '../ui/Rating'
import { BookCover } from './BookCover'
import { ShelfMenu } from './ShelfMenu'
import { authorName, type Book, type ReadingStatus } from '../../types/books'

interface BookCardProps {
  book: Book
  /**
   * `grid` — cover above text, for shelves and result grids.
   * `row` — cover beside text with the blurb, for lists.
   */
  variant?: 'grid' | 'row'
  /** Called when the reader changes this book's shelf from the card. */
  onShelfChange?: (status: ReadingStatus | null) => void
  /** Hides the shelf control where the surrounding page provides its own. */
  hideShelf?: boolean
}

export function BookCard({
  book,
  variant = 'grid',
  onShelfChange,
  hideShelf = false,
}: BookCardProps) {
  const to = `/book/${book.id}`
  const primaryGenre = book.genres[0]

  return (
    <article className={cn('book-card', `book-card--${variant}`)}>
      <Link className="book-card__cover-link" to={to} tabIndex={-1} aria-hidden="true">
        <BookCover book={book} size={variant === 'row' ? 'sm' : 'md'} />
      </Link>

      <div className="book-card__body">
        <div className="book-card__meta-top">
          {primaryGenre ? (
            <span
              className="chip chip--genre chip--sm"
              style={genreChipStyle(primaryGenre.hue) as CSSProperties}
            >
              {primaryGenre.name}
            </span>
          ) : null}
        </div>

        <h3 className="book-card__title">
          <Link to={to}>{book.title}</Link>
        </h3>

        <p className="book-card__author">{authorName(book.author)}</p>

        {variant === 'row' && book.description ? (
          <p className="book-card__blurb">{book.description}</p>
        ) : null}

        <div className="book-card__stats">
          {book.ratingAverage === null ? (
            <span className="book-card__dim">Not yet rated</span>
          ) : (
            <span className="book-card__rating">
              <Stars value={book.ratingAverage} size="0.85em" />
              <strong>{formatRating(book.ratingAverage)}</strong>
            </span>
          )}
          <span className="book-card__stat">
            <Icon name="eye" size="0.9em" />
            {formatCount(book.viewCount)}
          </span>
        </div>

        {hideShelf ? null : (
          <div className="book-card__shelf">
            <ShelfMenu
              bookId={book.id}
              status={book.libraryStatus}
              onChange={(status) => onShelfChange?.(status)}
            />
          </div>
        )}
      </div>
    </article>
  )
}

/** Placeholder matching the grid card's shape. */
export function BookCardSkeleton({ variant = 'grid' }: { variant?: 'grid' | 'row' }) {
  return (
    <div className={cn('book-card', `book-card--${variant}`, 'book-card--skeleton')}>
      <span className="skeleton book-card__cover-skeleton" />
      <div className="book-card__body">
        <span
          className="skeleton"
          style={{ width: '4.5rem', height: '1.1rem', borderRadius: 'var(--radius-full)' }}
        />
        <span className="skeleton" style={{ width: '85%', height: '1rem' }} />
        <span className="skeleton" style={{ width: '55%', height: '0.75rem' }} />
        <span className="skeleton" style={{ width: '70%', height: '0.75rem' }} />
      </div>
    </div>
  )
}
