import type { CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { cn } from '../../lib/cn'
import { hueFor } from '../../lib/cover'
import { daysUntil, formatCount, formatDate, formatRelative } from '../../lib/format'
import { Avatar } from '../ui/Avatar'
import { Button, ButtonLink } from '../ui/Button'
import { GenreChip, StatusBadge } from '../ui/Chip'
import { Icon } from '../ui/Icon'
import { ProgressBar } from '../ui/Progress'
import { StoryCover } from './StoryCover'
import { channelAuthorName, type Channel } from '../../types/channels'
import { CLUB_ROLE_LABELS, type Club } from '../../types/clubs'
import type { Challenge } from '../../types/challenges'
import type { BadgeProgress } from '../../types/gamification'

/* Author ---------------------------------------------------------------
 *
 * `AuthorCard` left with the mock layer. Nothing imported it, and the only
 * shape it fitted was the mock's `User`: it wanted a `bio` and a
 * `followerCount` on the same object as the handle, which no API response
 * carries together. The onboarding author picker, the one surface that shows
 * authors as cards, renders `SuggestedAuthor` inline from
 * `GET /api/recommendations/authors` instead.
 */

/* Genre ----------------------------------------------------------------
 *
 * `GenreCard` left with the mock layer, for `AuthorCard`'s reason. Nothing
 * imported it, and the blurb it was built around -- the whole difference
 * between it and a `GenreChip` -- came only from the mock's hand-written genre
 * list. `content.Genre` stores a name and a hue, and `GET /api/books/genres`
 * adds a count; there is no description to render and none was ever written.
 * The genre list on Discover renders chips.
 */

/* Challenge ----------------------------------------------------------- */

const CHALLENGE_TONE = {
  active: 'success',
  upcoming: 'brand',
  past: 'neutral',
} as const

/** What each state is called on screen; `past` reads badly as a badge. */
const CHALLENGE_LABEL = {
  active: 'active',
  upcoming: 'upcoming',
  past: 'ended',
} as const

export function ChallengeCard({ challenge }: { challenge: Challenge }) {
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
      style={{ '--challenge-hue': hueFor(challenge.slug) } as CSSProperties}
    >
      <div className="challenge-card__head">
        <StatusBadge tone={CHALLENGE_TONE[challenge.state]}>
          {CHALLENGE_LABEL[challenge.state]}
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
  club: Club
  onToggleMembership?: (club: Club) => void
  pending?: boolean
}

export function ClubCard({ club, onToggleMembership, pending = false }: ClubCardProps) {
  const joined = club.membership !== null

  return (
    <article
      className="club-card"
      /**
       * `clubs.BookClub` has no hue column — the mock's was invented — so the
       * banner colour is derived from the slug instead. Deterministic, so a
       * club keeps its colour across reloads and between light and dark.
       */
      style={{ '--club-hue': hueFor(club.slug) } as CSSProperties}
    >
      <div className="club-card__banner" aria-hidden="true">
        {club.currentStory ? <StoryCover story={club.currentStory} size="xs" /> : null}
      </div>

      <div className="club-card__body">
        <div className="club-card__head">
          <h3 className="club-card__title">
            <Link to={`/clubs/${club.slug}`}>{club.name}</Link>
          </h3>
          {club.membership ? (
            <StatusBadge tone="brand">{CLUB_ROLE_LABELS[club.membership.role]}</StatusBadge>
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

export function ChannelCard({ channel }: { channel: Channel }) {
  return (
    <article className="channel-card">
      <div className="channel-card__head">
        <Avatar user={channel.author} size="md" />
        <div className="channel-card__ident">
          <h3 className="channel-card__title">
            <Link to={`/channels/${channel.slug}`}>{channel.name}</Link>
          </h3>
          <p className="channel-card__author">{channelAuthorName(channel.author)}</p>
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
          {formatCount(channel.postCount)} posts
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

export function BadgeTile({ entry }: { entry: BadgeProgress }) {
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
