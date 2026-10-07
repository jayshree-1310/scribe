import { useEffect } from 'react'
import type { ChapterSummary } from '../../types/stories'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { AskBookPanel } from './AskBookPanel'
import './reader-ai.css'
import './ask.css'

/**
 * Ask This Book inside the reader.
 *
 * The explain sheet's shell — docked to the bottom, the reading measure wide,
 * one scroll region — for the reasons that shell exists: a panel floating over
 * the page covers the text, and the reader is in the middle of it. See
 * `ExplainSheet`.
 *
 * The range follows the chapter being read rather than the saved position:
 * the reader is *here*, which is the most accurate answer to "how far have
 * they read", and the saved position can lag a chapter behind a reader who
 * has just turned the page.
 *
 * Following a citation closes the sheet; the panel remembers the open
 * conversation for the tab, so opening it again carries on where it was.
 */

interface AskBookSheetProps {
  storyId: string
  storySlug: string
  chapters: ReadonlyArray<ChapterSummary>
  chapterNumber: number
  /** Following a citation navigates; the host decides what else that means. */
  onCite: () => void
  onClose: () => void
}

export function AskBookSheet({
  storyId,
  storySlug,
  chapters,
  chapterNumber,
  onCite,
  onClose,
}: AskBookSheetProps) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <aside
      className="explain-sheet ask-sheet"
      role="dialog"
      aria-label="Ask this book"
    >
      <div className="explain-sheet__inner">
        <div className="explain-sheet__head">
          <Icon name="sparkle" className="explain-sheet__mark" size="0.95rem" />
          <h2 className="ask-sheet__title">Ask this book</h2>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Close"
            onClick={onClose}
            startIcon={<Icon name="close" size="1rem" />}
          />
        </div>

        <div className="explain-sheet__body">
          <AskBookPanel
            storyId={storyId}
            storySlug={storySlug}
            chapters={chapters}
            defaultUpTo={chapterNumber}
            variant="reader"
            onCite={onCite}
            autoFocus
          />
        </div>
      </div>
    </aside>
  )
}
