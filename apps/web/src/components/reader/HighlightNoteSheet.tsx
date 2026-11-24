import { useState } from 'react'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { TextField } from '../ui/TextField'
import {
  HIGHLIGHT_NOTE_LIMIT,
  plainQuote,
  type SavedHighlight,
} from '../../types/highlights'
import { ReaderPanel } from './ReaderPanel'
import '../ai/reader-ai.css'
import './highlights.css'

/**
 * One highlight's private note: write it, change it, or remove the highlight.
 *
 * In the reader's side panel, the quote clamped above, for the reason
 * `ExplainSheet` gives: a popover beside the passage covers the passage. It
 * opens on a fresh highlight, so the note is one step away from making it,
 * and on a tap on any highlight already on the page.
 *
 * Mounted per highlight (keyed by id in `ReaderPage`), so the draft below is
 * initialised from the saved note and never has to be reset from an effect.
 */

interface HighlightNoteSheetProps {
  highlight: SavedHighlight
  /** Focus the note at once, for a highlight just made. */
  autoFocus?: boolean
  onSave: (note: string | null) => Promise<void>
  onRemove: () => Promise<void>
  /**
   * Opens the quote card for this passage. Absent where a card is not
   * offered: a draft, or a story whose author turned quote cards off.
   */
  onQuoteCard?: () => void
  onClose: () => void
}

export function HighlightNoteSheet({
  highlight,
  autoFocus = false,
  onSave,
  onRemove,
  onQuoteCard,
  onClose,
}: HighlightNoteSheetProps) {
  const [draft, setDraft] = useState(highlight.note ?? '')
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null)
  const [error, setError] = useState<string | undefined>()

  const changed = draft.trim() !== (highlight.note ?? '')

  async function run(kind: 'save' | 'remove') {
    setBusy(kind)
    setError(undefined)
    try {
      if (kind === 'save') await onSave(draft.trim() === '' ? null : draft.trim())
      else await onRemove()
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'That did not save. Try again.',
      )
      setBusy(null)
    }
  }

  return (
    <ReaderPanel
      label="Highlight"
      icon="highlight"
      title="Your highlight"
      className="highlight-sheet"
      onClose={onClose}
      actions={
        onQuoteCard ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onQuoteCard}
            startIcon={<Icon name="share" size="0.95em" />}
          >
            Quote card
          </Button>
        ) : null
      }
    >
      <div className="explain-sheet__body">
        <blockquote className="explain-sheet__passage">
          {plainQuote(highlight.quote)}
        </blockquote>

        <form
          className="highlight-sheet__form"
          onSubmit={(event) => {
            event.preventDefault()
            void run('save')
          }}
        >
          <TextField
            multiline
            rows={2}
            label="Private note"
            hideLabel
            placeholder="Add a private note — only you will see it."
            value={draft}
            maxLength={HIGHLIGHT_NOTE_LIMIT}
            error={error}
            disabled={busy !== null}
            autoFocus={autoFocus}
            onChange={(event) => {
              setDraft(event.target.value)
              setError(undefined)
            }}
          />

          <div className="highlight-sheet__actions">
            <Button
              variant="ghost"
              size="sm"
              loading={busy === 'remove'}
              disabled={busy !== null}
              onClick={() => void run('remove')}
              startIcon={<Icon name="trash" size="0.95em" />}
            >
              Remove highlight
            </Button>
            <Button
              variant="primary"
              size="sm"
              type="submit"
              loading={busy === 'save'}
              disabled={busy !== null || !changed}
            >
              {highlight.note ? 'Save note' : 'Add note'}
            </Button>
          </div>
        </form>
      </div>
    </ReaderPanel>
  )
}
