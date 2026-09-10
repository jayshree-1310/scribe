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
 * Structural rather than one concrete story type: the real stories from
 * `types/stories.ts` and the mock ones from `types/domain.ts` differ in the
 * blurb field and in whether a display name exists, and both are on screen
 * until the mock layer is retired. The optional fields below are exactly those
 * differences — everything else is common to both.
 */
export interface CardStory {
  id: string
  slug: string
  title: string
  status: 'draft' | 'ongoing' | 'completed' | 'hiatus'
  viewCount: number
  chapterCount: number
  ratingAverage: number | null
  ratingCount: number
  /** Editorial pull quote, mock-only for now; used by the feature variant. */
  tagline?: string
  /** The mock's name for the blurb. */
  synopsis?: string
  /** The API's name for the same thing. */
  description?: string | null
  author: { username: string; displayName?: string | null }
  genres: Array<{ id: string; name: string; hue: number; slug?: string }>
}

const STATUS_LABELS: Record<CardStory['status'], string> = {
  draft: 'Draft',
  ongoing: 'Ongoing',
  completed: 'Completed',
  hiatus: 'On hiatus',
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
  const blurb = story.synopsis ?? story.description ?? ''
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
          ) : story.status === 'hiatus' ? (
            <StatusBadge tone="warning">{STATUS_LABELS.hiatus}</StatusBadge>
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

        {variant !== 'grid' ? (
          <p className="story-card__synopsis">
            {variant === 'feature' ? (story.tagline ?? blurb) : blurb}
          </p>
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
