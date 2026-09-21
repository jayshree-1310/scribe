import { Link } from 'react-router-dom'
import { cn } from '../../lib/cn'
import { formatCount, formatRating } from '../../lib/format'
import { Icon } from '../ui/Icon'
import { GenreChip, StatusBadge } from '../ui/Chip'
import { Stars } from '../ui/Rating'
import { StoryCover } from './StoryCover'

/**
 * What a card renders, and no more.
 *
 * Still structural rather than `types/stories.ts`'s `Story`, because a card is
 * drawn for a catalogue `Book` too and the two rows differ in fields nothing
 * here reads. It is no longer structural to span *two* story shapes: it used
 * to carry a `tagline`, a `synopsis` and a `hiatus` status alongside the API's
 * names for the first two, because the mock spelled them differently. Nothing
 * supplies those now — `content.Story` has one blurb, called `description`,
 * and the API derives three statuses from `listedAt` and `isCompleted`.
 */
export interface CardStory {
  id: string
  slug: string
  title: string
  status: 'draft' | 'ongoing' | 'completed'
  viewCount: number
  chapterCount: number
  ratingAverage: number | null
  ratingCount: number
  description?: string | null
  author: { username: string; displayName?: string | null }
  genres: Array<{ id: string; name: string; hue: number }>
}

const STATUS_LABELS: Record<CardStory['status'], string> = {
  draft: 'Draft',
  ongoing: 'Ongoing',
  completed: 'Completed',
}

interface StoryCardProps {
  story: CardStory
  /**
   * `grid` — cover above text, for shelves and result grids.
   * `row` — cover beside text with synopsis, for lists.
   * `feature` — large editorial treatment for the top of a page.
   */
  variant?: 'grid' | 'row' | 'feature'
  /** Hides the author line when the surrounding context already names them. */
  hideAuthor?: boolean
  rank?: number
}

export function StoryCard({
  story,
  variant = 'grid',
  hideAuthor = false,
  rank,
}: StoryCardProps) {
  const to = `/story/${story.slug}`
  const primaryGenre = story.genres[0]
  const blurb = story.description ?? ''
  const rating = story.ratingAverage ?? 0

  return (
    <article className={cn('story-card', `story-card--${variant}`)}>
      <Link className="story-card__cover-link" to={to} tabIndex={-1} aria-hidden="true">
        <StoryCover story={story} size={variant === 'feature' ? 'lg' : variant === 'row' ? 'sm' : 'md'} />
        {rank === undefined ? null : <span className="story-card__rank">{rank}</span>}
      </Link>

      <div className="story-card__body">
        <div className="story-card__meta-top">
          {primaryGenre ? <GenreChip genre={primaryGenre} /> : null}
          {story.status === 'completed' ? (
            <StatusBadge tone="success">{STATUS_LABELS.completed}</StatusBadge>
          ) : null}
        </div>

        <h3 className="story-card__title">
          <Link to={to}>{story.title}</Link>
        </h3>

        {hideAuthor ? null : (
          <p className="story-card__author">
            by{' '}
            <Link to={`/profile/${story.author.username}`}>
              {story.author.displayName || story.author.username}
            </Link>
          </p>
        )}

        {/* The feature variant used to prefer a `tagline` here, which only the
            mock carried; there is one blurb on a story now. */}
        {variant !== 'grid' ? (
          <p className="story-card__synopsis">{blurb}</p>
        ) : null}

        <div className="story-card__stats">
          {/* An unrated story says nothing rather than showing five empty
              stars next to a zero, which reads as a bad score. */}
          {story.ratingAverage === null ? (
            <span className="story-card__dim">Not rated yet</span>
          ) : (
            <span className="story-card__rating">
              <Stars value={rating} size="0.85em" />
              <strong>{formatRating(rating)}</strong>
              <span className="story-card__dim">({formatCount(story.ratingCount)})</span>
            </span>
          )}
          <span className="story-card__stat">
            <Icon name="eye" size="0.9em" />
            {formatCount(story.viewCount)}
          </span>
          <span className="story-card__stat">
            <Icon name="book" size="0.9em" />
            {story.chapterCount} ch
          </span>
        </div>
      </div>
    </article>
  )
}

/** Placeholder matching the grid card's shape. */
export function StoryCardSkeleton({ variant = 'grid' }: { variant?: 'grid' | 'row' }) {
  return (
    <div className={cn('story-card', `story-card--${variant}`, 'story-card--skeleton')}>
      <span className="skeleton story-card__cover-skeleton" />
      <div className="story-card__body">
        <span className="skeleton" style={{ width: '4.5rem', height: '1.1rem', borderRadius: 'var(--radius-full)' }} />
        <span className="skeleton" style={{ width: '85%', height: '1rem' }} />
        <span className="skeleton" style={{ width: '55%', height: '0.75rem' }} />
        <span className="skeleton" style={{ width: '70%', height: '0.75rem' }} />
      </div>
    </div>
  )
}
