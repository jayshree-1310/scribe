import type { ChapterSummary } from '../../types/stories'
import { ReaderPanel } from '../reader/ReaderPanel'
import { AskBookPanel } from './AskBookPanel'
import './reader-ai.css'
import './ask.css'

/**
 * Ask This Book inside the reader.
 *
 * In the reader's side panel (`ReaderPanel`), with one scroll region, for
 * the reasons that shell exists: a panel floating over the page covers the
 * text, and the reader is in the middle of it.
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
  return (
    <ReaderPanel
      label="Ask this book"
      icon="sparkle"
      title="Ask this book"
      className="ask-sheet"
      onClose={onClose}
    >
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
    </ReaderPanel>
  )
}
