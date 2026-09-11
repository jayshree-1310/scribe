import { Link } from 'react-router-dom'
import { formatPercent, formatRelative } from '../../lib/format'
import { ButtonLink } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { ProgressBar } from '../ui/Progress'
import { StoryCover } from './StoryCover'
import { storyAuthorName } from '../../types/stories'
import type { ContinueEntry } from '../../types/stories'

/** "Continue reading" tile: where you left off, and one tap back in. */
export function ContinueCard({ entry }: { entry: ContinueEntry }) {
  const { story, chapter, progress } = entry

  /**
   * The API reports whole-story completion as 0–100; `ProgressBar` and
   * `formatPercent` both take a 0–1 fraction.
   */
  const fraction = progress.percentComplete / 100

  /**
   * A position saved against a chapter that has since been deleted still has
   * a story to open — so the card degrades to the story page rather than
   * linking at a chapter that is no longer there.
   */
  const resumeTo =
    chapter === null
      ? `/story/${story.slug}`
      : `/read/${story.slug}/${chapter.number}`

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
        <p className="continue-card__author">{storyAuthorName(story.author)}</p>

        {chapter === null ? null : (
          <p className="continue-card__chapter">
            <Icon name="book-open" size="0.9em" />
            Chapter {chapter.number} — {chapter.title}
          </p>
        )}

        <div className="continue-card__progress">
          <ProgressBar
            value={fraction}
            label={`${formatPercent(fraction)} through ${story.title}`}
          />
          <span className="continue-card__percent">
            {formatPercent(fraction)}
          </span>
        </div>

        <div className="continue-card__foot">
          <ButtonLink
            variant="primary"
            size="sm"
            to={resumeTo}
            startIcon={<Icon name="book-open" size="0.95em" />}
          >
            Continue reading
          </ButtonLink>
          <span className="continue-card__when">
            {formatRelative(progress.lastReadAt)}
          </span>
        </div>
      </div>
    </article>
  )
}
