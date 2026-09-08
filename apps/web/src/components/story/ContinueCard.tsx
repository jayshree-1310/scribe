import { Link } from 'react-router-dom'
import { formatPercent, formatRelative } from '../../lib/format'
import { ButtonLink } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { ProgressBar } from '../ui/Progress'
import { StoryCover } from './StoryCover'
import type { ReadingEntry } from '../../types/domain'

/** "Continue reading" tile: where you left off, and one tap back in. */
export function ContinueCard({ entry }: { entry: ReadingEntry }) {
  const { story, chapter, history } = entry

  return (
    <article className="continue-card">
      <Link
        className="continue-card__cover"
        to={`/story/${story.slug}`}
        tabIndex={-1}
        aria-hidden="true"
      >
        <StoryCover story={story} size="sm" />
      </Link>

      <div className="continue-card__body">
        <h3 className="continue-card__title">
          <Link to={`/story/${story.slug}`}>{story.title}</Link>
        </h3>
        <p className="continue-card__author">{story.author.displayName}</p>

        <p className="continue-card__chapter">
          <Icon name="book-open" size="0.9em" />
          Chapter {chapter.number} — {chapter.title}
        </p>

        <div className="continue-card__progress">
          <ProgressBar
            value={history.storyProgress}
            label={`${formatPercent(history.storyProgress)} through ${story.title}`}
          />
          <span className="continue-card__percent">
            {formatPercent(history.storyProgress)}
          </span>
        </div>

        <div className="continue-card__foot">
          <ButtonLink
            variant="primary"
            size="sm"
            to={`/read/${story.slug}/${chapter.number}`}
            startIcon={<Icon name="book-open" size="0.95em" />}
          >
            Continue reading
          </ButtonLink>
          <span className="continue-card__when">{formatRelative(history.lastReadAt)}</span>
        </div>
      </div>
    </article>
  )
}
