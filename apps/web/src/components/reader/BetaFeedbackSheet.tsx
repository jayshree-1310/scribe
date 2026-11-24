import { useState } from 'react'
import { useAsync } from '../../hooks/useAsync'
import { formatRelative } from '../../lib/format'
import type { ChapterSelection } from '../../lib/chapter-selection'
import * as betaApi from '../../data/beta-api'
import { BETA_FEEDBACK_LIMIT, type BetaFeedback } from '../../types/beta'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Skeleton } from '../ui/Skeleton'
import { TextField } from '../ui/TextField'
import { ReaderPanel } from './ReaderPanel'
import '../ai/reader-ai.css'
import './highlights.css'
import './beta.css'

/**
 * A beta reader's private notes to the author on the chapter they are
 * reading: write one, optionally about the passage they selected, and see,
 * change or delete the ones they already left here.
 *
 * In the reader's side panel, like the highlights list and Ask This Book.
 * Opened from the reader's top bar, or from "Feedback" on a selection, which brings the
 * passage with it -- as offsets, so the API quotes the chapter itself.
 */

interface BetaFeedbackSheetProps {
  storyId: string
  chapterId: string
  chapterNumber: number
  authorName: string
  /** A passage the reader selected, or null for the whole chapter. */
  passage: ChapterSelection | null
  onClearPassage: () => void
  onClose: () => void
}

function plain(quote: string): string {
  return quote.replace(/[*_]/g, '')
}

export function BetaFeedbackSheet({
  storyId,
  chapterId,
  chapterNumber,
  authorName,
  passage,
  onClearPassage,
  onClose,
}: BetaFeedbackSheetProps) {
  const mine = useAsync(() => betaApi.listFeedback(storyId), [storyId])
  const here = (mine.data ?? []).filter((item) => item.chapterId === chapterId)

  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [itemError, setItemError] = useState<string | null>(null)

  async function onSend(event: React.FormEvent) {
    event.preventDefault()
    if (draft.trim() === '') {
      setError('Write something first.')
      return
    }
    setSending(true)
    setError(undefined)
    try {
      await betaApi.createFeedback({
        chapterId,
        body: draft.trim(),
        ...(passage ? { start: passage.start, end: passage.end } : {}),
      })
      setDraft('')
      onClearPassage()
      mine.reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not send. Try again.')
    } finally {
      setSending(false)
    }
  }

  async function run(item: BetaFeedback, action: 'save' | 'delete') {
    setBusyId(item.id)
    setItemError(null)
    try {
      if (action === 'save' && editing) await betaApi.updateFeedback(item.id, editing.body.trim())
      else await betaApi.deleteFeedback(item.id)
      setEditing(null)
      mine.reload()
    } catch (cause) {
      setItemError(cause instanceof Error ? cause.message : 'That did not work. Try again.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <ReaderPanel
      label="Beta feedback"
      icon="lock"
      title={`Feedback on chapter ${chapterNumber}`}
      className="highlights-sheet"
      onClose={onClose}
    >
      <div className="explain-sheet__body">
        <p className="explain-sheet__hint">
          Only {authorName} sees this. It is not a public comment.
        </p>

        {passage ? (
          <div className="beta-sheet__passage">
            <blockquote className="explain-sheet__passage">{plain(passage.text)}</blockquote>
            <button type="button" className="highlights-sheet__retry" onClick={onClearPassage}>
              About the whole chapter instead
            </button>
          </div>
        ) : null}

        <form className="highlight-sheet__form" onSubmit={onSend}>
          <TextField
            multiline
            rows={3}
            label="Your feedback"
            hideLabel
            placeholder={
              passage
                ? 'What did this passage do for you?'
                : 'What worked, what lost you, what you wanted more of…'
            }
            value={draft}
            maxLength={BETA_FEEDBACK_LIMIT}
            error={error}
            disabled={sending}
            autoFocus={passage !== null}
            onChange={(event) => {
              setDraft(event.target.value)
              setError(undefined)
            }}
          />
          <div className="highlight-sheet__actions beta-sheet__actions">
            <Button
              variant="primary"
              size="sm"
              type="submit"
              loading={sending}
              startIcon={<Icon name="send" size="0.95em" />}
            >
              Send to the author
            </Button>
          </div>
        </form>

        <h3 className="highlights-sheet__chapter beta-sheet__heading">Your notes on this chapter</h3>
        {mine.status === 'loading' && mine.data === null ? (
          <Skeleton height="3rem" radius="var(--radius-md)" />
        ) : mine.status === 'error' ? (
          <p className="explain-sheet__error">
            {mine.error ?? 'Your notes could not be loaded.'}{' '}
            <button type="button" className="highlights-sheet__retry" onClick={mine.reload}>
              Try again
            </button>
          </p>
        ) : here.length === 0 ? (
          <p className="explain-sheet__hint">Nothing sent on this chapter yet.</p>
        ) : (
          <ul className="highlights-sheet__list">
            {here.map((item) => (
              <li key={item.id}>
                <div className="highlights-sheet__item">
                  {item.quote ? (
                    <span className="highlights-sheet__quote">{plain(item.quote)}</span>
                  ) : null}
                  {editing?.id === item.id ? (
                    <TextField
                      multiline
                      rows={2}
                      label="Edit feedback"
                      hideLabel
                      value={editing.body}
                      maxLength={BETA_FEEDBACK_LIMIT}
                      disabled={busyId === item.id}
                      onChange={(event) => setEditing({ id: item.id, body: event.target.value })}
                    />
                  ) : (
                    <span className="highlights-sheet__note">{item.body}</span>
                  )}
                  <span className="highlights-sheet__gone">
                    {formatRelative(item.createdAt)}
                    {editing?.id === item.id ? (
                      <>
                        <button
                          type="button"
                          className="highlights-sheet__retry"
                          disabled={busyId === item.id || editing.body.trim() === ''}
                          onClick={() => void run(item, 'save')}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="highlights-sheet__retry"
                          onClick={() => setEditing(null)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="highlights-sheet__retry"
                          onClick={() => setEditing({ id: item.id, body: item.body })}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="highlights-sheet__retry"
                          disabled={busyId === item.id}
                          onClick={() => void run(item, 'delete')}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
        {itemError ? <p className="explain-sheet__error">{itemError}</p> : null}
      </div>
    </ReaderPanel>
  )
}
