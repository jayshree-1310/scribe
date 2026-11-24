import { Skeleton } from '../ui/Skeleton'
import { ReaderPanel } from './ReaderPanel'
import { cn } from '../../lib/cn'
import { plainQuote, type SavedHighlight } from '../../types/highlights'
import '../ai/reader-ai.css'
import './highlights.css'

/**
 * Every highlight the reader has made in this story, in reading order, so
 * they can jump back to one.
 *
 * In the reader's side panel, opened from the reader's top bar.
 * It is also the keyboard route to a highlight's note: highlights are painted
 * with the Custom Highlight API, which draws no element to tab to.
 *
 * A highlight whose passage the author has since removed stays listed, with
 * its note, marked as gone -- the note is the reader's writing -- and is the
 * one kind offered a delete here rather than a jump.
 */

interface HighlightsSheetProps {
  highlights: SavedHighlight[] | null
  status: 'loading' | 'ready' | 'error'
  error?: string | null
  currentChapterId: string | null
  onPick: (highlight: SavedHighlight) => void
  onRemove: (highlight: SavedHighlight) => void
  onRetry: () => void
  onClose: () => void
}

export function HighlightsSheet({
  highlights,
  status,
  error,
  currentChapterId,
  onPick,
  onRemove,
  onRetry,
  onClose,
}: HighlightsSheetProps) {
  /** Chapter by chapter, keeping the API's reading order. */
  const groups: Array<{ chapterId: string; label: string; items: SavedHighlight[] }> = []
  for (const highlight of highlights ?? []) {
    const last = groups[groups.length - 1]
    if (last && last.chapterId === highlight.chapterId) last.items.push(highlight)
    else
      groups.push({
        chapterId: highlight.chapterId,
        label: `${highlight.chapterNumber}. ${highlight.chapterTitle}`,
        items: [highlight],
      })
  }

  return (
    <ReaderPanel
      label="Your highlights in this story"
      icon="highlight"
      title="Your highlights"
      className="highlights-sheet"
      onClose={onClose}
    >
      <div className="explain-sheet__body">
        {status === 'loading' && highlights === null ? (
          <Skeleton height="4rem" radius="var(--radius-md)" />
        ) : status === 'error' ? (
          <p className="explain-sheet__error">
            {error ?? 'Your highlights could not be loaded.'}{' '}
            <button type="button" className="highlights-sheet__retry" onClick={onRetry}>
              Try again
            </button>
          </p>
        ) : groups.length === 0 ? (
          <p className="explain-sheet__hint">
            Nothing highlighted in this story yet. Select a passage and
            choose Highlight to keep it here, with a private note if you
            like.
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.chapterId} className="highlights-sheet__group">
              <h3 className="highlights-sheet__chapter">
                {group.label}
                {group.chapterId === currentChapterId ? (
                  <span className="highlights-sheet__here"> · this chapter</span>
                ) : null}
              </h3>
              <ul className="highlights-sheet__list">
                {group.items.map((highlight) => (
                  <li key={highlight.id}>
                    {highlight.found ? (
                      <button
                        type="button"
                        className="highlights-sheet__item"
                        onClick={() => onPick(highlight)}
                      >
                        <span className="highlights-sheet__quote">
                          {plainQuote(highlight.quote)}
                        </span>
                        {highlight.note ? (
                          <span className="highlights-sheet__note">{highlight.note}</span>
                        ) : null}
                      </button>
                    ) : (
                      <div className={cn('highlights-sheet__item', 'is-gone')}>
                        <span className="highlights-sheet__quote">
                          {plainQuote(highlight.quote)}
                        </span>
                        {highlight.note ? (
                          <span className="highlights-sheet__note">{highlight.note}</span>
                        ) : null}
                        <span className="highlights-sheet__gone">
                          The author has changed this passage, so it is no
                          longer in the chapter.
                          <button
                            type="button"
                            className="highlights-sheet__retry"
                            onClick={() => onRemove(highlight)}
                          >
                            Remove
                          </button>
                        </span>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </ReaderPanel>
  )
}
