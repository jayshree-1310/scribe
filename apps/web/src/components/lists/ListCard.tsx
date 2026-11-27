import { Link } from 'react-router-dom'
import { formatCount } from '../../lib/format'
import { StatusBadge } from '../ui/Chip'
import { Icon } from '../ui/Icon'
import { Skeleton } from '../ui/Skeleton'
import { StoryCover } from '../story/StoryCover'
import { ownerName, type ReadingList } from '../../types/reading-lists'
import './lists.css'

/**
 * A reading list as a card: a fan of its newest covers, its name and curator,
 * and the two counts. Built on the channel card's frame, since a list is the
 * other thing one reader makes for others to follow.
 */
export function ListCard({
  list,
  hideOwner = false,
}: {
  list: ReadingList
  /** For a profile's own tab, where the owner is the page. */
  hideOwner?: boolean
}) {
  const to = `/lists/${list.slug}`

  return (
    <article className="channel-card list-card">
      <Link className="list-card__covers" to={to} tabIndex={-1} aria-hidden="true">
        {list.previews.length === 0 ? (
          <span className="list-card__empty">
            <Icon name="list" size="1.4rem" />
          </span>
        ) : (
          list.previews.map((story) => (
            <StoryCover key={story.id} story={story} size="xs" className="list-card__cover" />
          ))
        )}
      </Link>

      <div className="channel-card__head">
        <div className="channel-card__ident">
          <h3 className="channel-card__title">
            <Link to={to}>{list.name}</Link>
          </h3>
          {hideOwner ? null : (
            <p className="channel-card__author">by {ownerName(list.owner)}</p>
          )}
        </div>
        {!list.isPublic ? (
          <StatusBadge icon={<Icon name="lock" size="0.85em" />}>Private</StatusBadge>
        ) : list.following ? (
          <StatusBadge tone="brand">Following</StatusBadge>
        ) : null}
      </div>

      {list.description ? <p className="channel-card__desc">{list.description}</p> : null}

      <div className="channel-card__foot">
        <span>
          <Icon name="book" size="0.9em" />
          {formatCount(list.storyCount)} {list.storyCount === 1 ? 'story' : 'stories'}
        </span>
        {list.isPublic ? (
          <span>
            <Icon name="users" size="0.9em" />
            {formatCount(list.followerCount)} {list.followerCount === 1 ? 'follower' : 'followers'}
          </span>
        ) : null}
      </div>
    </article>
  )
}

/** Placeholder matching the card's shape. */
export function ListCardSkeleton() {
  return <Skeleton height="13rem" radius="var(--radius-lg)" />
}
