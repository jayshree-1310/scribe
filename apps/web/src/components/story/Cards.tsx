import type { CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { cn } from '../../lib/cn'
import { daysUntil, formatCount, formatDate, formatRelative } from '../../lib/format'
import { Avatar } from '../ui/Avatar'
import { Button, ButtonLink } from '../ui/Button'
import { GenreChip, StatusBadge } from '../ui/Chip'
import { Icon } from '../ui/Icon'
import { ProgressBar } from '../ui/Progress'
import { StoryCover } from './StoryCover'
import type { BadgeWithProgress, ChannelWithMeta, ClubWithMeta } from '../../data/api'
import type { User, WritingChallenge } from '../../types/domain'

/* Author -------------------------------------------------------------- */

export function AuthorCard({ author }: { author: User }) {
  return (
    <article className="author-card">
      <Link className="author-card__link" to={`/profile/${author.username}`}>
        <Avatar user={author} size="lg" />
        <span className="author-card__name">{author.displayName}</span>
        <span className="author-card__handle">@{author.username}</span>
      </Link>
      <p className="author-card__bio">{author.bio}</p>
      <p className="author-card__followers">
        <Icon name="users" size="0.9em" />
        {formatCount(author.followerCount)} followers
      </p>
    </article>
  )
}

/* Genre --------------------------------------------------------------- */

/**
 * Structural, like `GenreChip`: mock genres carry a slug and a blurb, API
 * genres carry an id and neither. Discover accepts either as its filter.
 */
interface CardGenre {
  id?: string
  name: string
  hue: number
  storyCount: number
  slug?: string
  description?: string
}

export function GenreCard({ genre }: { genre: CardGenre }) {
  return (
    <Link
      className="genre-card"
      to={`/discover?genre=${genre.slug ?? genre.id ?? ''}`}
      style={{ '--genre-hue': genre.hue } as CSSProperties}
    >
      <span className="genre-card__name">{genre.name}</span>
      {genre.description ? (
        <span className="genre-card__desc">{genre.description}</span>
      ) : null}
      <span className="genre-card__count">{formatCount(genre.storyCount)} stories</span>
    </Link>
  )
}

/* Challenge ----------------------------------------------------------- */

const CHALLENGE_TONE = {
  active: 'success',
  upcoming: 'brand',
  completed: 'neutral',
} as const

export function ChallengeCard({ challenge }: { challenge: WritingChallenge }) {
  const remaining = daysUntil(challenge.endsAt)
  const starts = daysUntil(challenge.startsAt)

  const timing =
    challenge.state === 'active'
      ? remaining <= 0
        ? 'Closing today'
        : `${remaining} day${remaining === 1 ? '' : 's'} left`
      : challenge.state === 'upcoming'
        ? `Opens in ${starts} day${starts === 1 ? '' : 's'}`
        : `Ended ${formatRelative(challenge.endsAt)}`

  return (
    <article
      className="challenge-card"
      style={{ '--challenge-hue': challenge.hue } as CSSProperties}
    >
      <div className="challenge-card__head">
        <StatusBadge tone={CHALLENGE_TONE[challenge.state]}>
          {challenge.state}
        </StatusBadge>
        <span className="challenge-card__timing">
          <Icon name="clock" size="0.9em" />
          {timing}
        </span>
      </div>

      <h3 className="challenge-card__title">
        <Link to={`/challenges/${challenge.slug}`}>{challenge.title}</Link>
      </h3>

      <p className="challenge-card__prompt">“{challenge.prompt}”</p>

      <div className="challenge-card__stats">
        <span>
          <Icon name="users" size="0.9em" />
          {formatCount(challenge.participantCount)} writers
        </span>
        <span>
          <Icon name="pen" size="0.9em" />
          {formatCount(challenge.entryCount)} entries
        </span>
        {challenge.wordTarget ? (
          <span>
            <Icon name="target" size="0.9em" />
            {formatCount(challenge.wordTarget)} words
          </span>
        ) : null}
      </div>
    </article>
  )
}

/* Club ---------------------------------------------------------------- */

interface ClubCardProps {
  club: ClubWithMeta
  onToggleMembership?: (club: ClubWithMeta) => void
  pending?: boolean
}

export function ClubCard({ club, onToggleMembership, pending = false }: ClubCardProps) {
  const joined = club.membership !== null

  return (
    <article className="club-card" style={{ '--club-hue': club.hue } as CSSProperties}>
      <div className="club-card__banner" aria-hidden="true">
        {club.currentStory ? <StoryCover story={club.currentStory} size="xs" /> : null}
      </div>

      <div className="club-card__body">
        <div className="club-card__head">
          <h3 className="club-card__title">
            <Link to={`/clubs/${club.slug}`}>{club.name}</Link>
          </h3>
          {club.isPrivate ? (
            <StatusBadge tone="plum" icon={<Icon name="lock" size="0.8em" />}>
              Private
            </StatusBadge>
          ) : null}
        </div>

        <p className="club-card__desc">{club.description}</p>

        {club.currentStory ? (
          <p className="club-card__reading">
            <Icon name="book-open" size="0.9em" />
            Reading <strong>{club.currentStory.title}</strong>
          </p>
        ) : null}

        <div className="club-card__foot">
          <span className="club-card__stats">
            <span>
              <Icon name="users" size="0.9em" />
              {formatCount(club.memberCount)}
            </span>
            <span>
              <Icon name="comment" size="0.9em" />
              {formatCount(club.discussionCount)}
            </span>
          </span>

          {onToggleMembership ? (
            <Button
              size="sm"
              variant={joined ? 'subtle' : 'primary'}
              loading={pending}
              onClick={() => onToggleMembership(club)}
            >
              {joined ? 'Joined' : 'Join club'}
            </Button>
          ) : (
            <ButtonLink size="sm" to={`/clubs/${club.slug}`}>
              View club
            </ButtonLink>
          )}
        </div>
      </div>
    </article>
  )
}

/* Channel -------------------------------------------------------------- */

export function ChannelCard({ channel }: { channel: ChannelWithMeta }) {
  return (
    <article className="channel-card">
      <div className="channel-card__head">
        <Avatar user={channel.author} size="md" />
        <div className="channel-card__ident">
          <h3 className="channel-card__title">
            <Link to={`/channels/${channel.slug}`}>{channel.name}</Link>
          </h3>
          <p className="channel-card__author">{channel.author.displayName}</p>
        </div>
        {channel.subscribed ? <StatusBadge tone="brand">Subscribed</StatusBadge> : null}
      </div>

      <p className="channel-card__desc">{channel.description}</p>

      <div className="channel-card__foot">
        <span>
          <Icon name="users" size="0.9em" />
          {formatCount(channel.subscriberCount)} subscribers
        </span>
        <span>
          <Icon name="megaphone" size="0.9em" />
          {channel.postCount} posts
        </span>
      </div>
    </article>
  )
}

/* Badge ---------------------------------------------------------------- */

const BADGE_ICONS: Record<string, Parameters<typeof Icon>[0]['name']> = {
  book: 'book',
  pencil: 'pencil',
  star: 'star-filled',
  flame: 'flame',
  library: 'library',
  trend: 'trend',
  crown: 'crown',
  users: 'users',
  clock: 'clock',
  trophy: 'trophy',
  quote: 'quote',
  moon: 'moon',
}

export function BadgeTile({ entry }: { entry: BadgeWithProgress }) {
  const { badge, earned, earnedAt, progress } = entry

  return (
    <article
      className={cn('badge-tile', `badge-tile--${badge.tier}`, earned ? 'is-earned' : 'is-locked')}
    >
      <span className="badge-tile__medal">
        <Icon name={BADGE_ICONS[badge.icon] ?? 'medal'} size="1.5rem" strokeWidth={1.6} />
        {earned ? null : (
          <span className="badge-tile__lock">
            <Icon name="lock" size="0.7rem" strokeWidth={2.2} />
          </span>
        )}
      </span>

      <h3 className="badge-tile__name">{badge.name}</h3>
      <p className="badge-tile__desc">{earned ? badge.description : badge.criteria}</p>

      {earned ? (
        <p className="badge-tile__earned">
          <Icon name="check-circle" size="0.9em" />
          Earned {earnedAt ? formatDate(earnedAt) : ''}
        </p>
      ) : (
        <div className="badge-tile__progress">
          <ProgressBar value={progress} label={`${badge.name} progress`} />
          <span>{Math.round(progress * 100)}%</span>
        </div>
      )}
    </article>
  )
}

/* Genre list ----------------------------------------------------------- */

export function GenreChipRow({ genres }: { genres: Array<{ id: string; name: string; slug: string; hue: number; storyCount: number; description: string }> }) {
  return (
    <div className="chip-row">
      {genres.map((genre) => (
        <GenreChip key={genre.id} genre={genre} asLink size="md" />
      ))}
    </div>
  )
}
