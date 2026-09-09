import { useState } from 'react'
import { useToast } from '../../lib/toast'
import { Button } from '../ui/Button'
import { DropdownMenu, MenuItem, MenuSeparator } from '../ui/DropdownMenu'
import { Icon } from '../ui/Icon'
import * as books from '../../data/books-api'
import {
  READING_STATUSES,
  READING_STATUS_LABELS,
  type ReadingStatus,
} from '../../types/books'

interface ShelfMenuProps {
  bookId: string
  /** The book's current shelf, or `null` when it is on none. */
  status: ReadingStatus | null
  /** Called with the new shelf — `null` once the book is removed. */
  onChange: (status: ReadingStatus | null) => void
  size?: 'sm' | 'md'
  /** Stretches the trigger to its container, for the detail page. */
  fullWidth?: boolean
}

/**
 * The one control that puts a book on a shelf, moves it between shelves and
 * takes it off again.
 *
 * The parent owns the status so the surrounding card or page re-renders with
 * it; this component owns only the in-flight state. A failed request leaves
 * the parent's status untouched and explains itself in a toast, so the UI
 * never claims a change the server refused.
 */
export function ShelfMenu({
  bookId,
  status,
  onChange,
  size = 'sm',
  fullWidth = false,
}: ShelfMenuProps) {
  const [pending, setPending] = useState(false)
  const { showToast } = useToast()

  async function run(
    action: () => Promise<void>,
    success: string,
  ): Promise<void> {
    if (pending) return
    setPending(true)
    try {
      await action()
      showToast({ message: success, tone: 'success' })
    } catch (error) {
      showToast({
        message:
          error instanceof Error
            ? error.message
            : "That didn't save. Please try again.",
        tone: 'error',
      })
    } finally {
      setPending(false)
    }
  }

  function select(next: ReadingStatus): void {
    if (next === status) return

    void run(async () => {
      if (status === null) await books.addToLibrary(bookId, next)
      else await books.setReadingStatus(bookId, next)
      onChange(next)
    }, status === null ? 'Added to your library.' : `Moved to ${READING_STATUS_LABELS[next]}.`)
  }

  function remove(): void {
    void run(async () => {
      await books.removeFromLibrary(bookId)
      onChange(null)
    }, 'Removed from your library.')
  }

  // Not on a shelf yet: one click is the whole interaction, so don't make
  // someone open a menu to say the obvious thing.
  if (status === null) {
    return (
      <Button
        size={size}
        variant="secondary"
        loading={pending}
        fullWidth={fullWidth}
        startIcon={<Icon name="plus" size="1em" />}
        onClick={() => select('WANT_TO_READ')}
      >
        Add to library
      </Button>
    )
  }

  return (
    <DropdownMenu
      label="Reading status"
      trigger={(triggerProps) => (
        <Button
          {...triggerProps}
          size={size}
          variant="subtle"
          loading={pending}
          fullWidth={fullWidth}
          startIcon={<Icon name="check" size="1em" />}
          endIcon={<Icon name="chevron-down" size="0.9em" />}
        >
          {READING_STATUS_LABELS[status]}
        </Button>
      )}
    >
      {READING_STATUSES.map((option) => (
        <MenuItem
          key={option}
          icon={
            option === status ? (
              <Icon name="check" size="1em" />
            ) : (
              <Icon name="book" size="1em" />
            )
          }
          onSelect={() => select(option)}
        >
          {READING_STATUS_LABELS[option]}
        </MenuItem>
      ))}

      <MenuSeparator />

      <MenuItem tone="danger" icon={<Icon name="trash" size="1em" />} onSelect={remove}>
        Remove from library
      </MenuItem>
    </DropdownMenu>
  )
}
