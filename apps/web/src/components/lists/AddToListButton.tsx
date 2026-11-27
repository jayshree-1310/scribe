import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAsync } from '../../hooks/useAsync'
import { useAuth } from '../../lib/auth'
import { useToast } from '../../lib/toast'
import { cn } from '../../lib/cn'
import * as listsApi from '../../data/reading-lists-api'
import { Button, type ButtonSize } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Icon } from '../ui/Icon'
import { Skeleton } from '../ui/Skeleton'
import { ErrorState } from '../ui/States'
import { TextField } from '../ui/TextField'
import { LIST_NAME_MAX, MAX_LISTS_PER_USER } from '../../types/reading-lists'
import './lists.css'

interface AddToListButtonProps {
  storyId: string
  storyTitle: string
  size?: ButtonSize
  /** Icon only, for a row of round buttons. */
  iconOnly?: boolean
  fullWidth?: boolean
}

/**
 * "Add to list" on a story or book page: a button, and the dialog behind it
 * that lists the reader's own lists with a tick on each one already holding
 * the story. A tap adds or removes; a new list can be started from here and
 * gets the story at once.
 *
 * Nothing for a signed-out visitor: a list belongs to an account.
 */
export function AddToListButton({
  storyId,
  storyTitle,
  size = 'lg',
  iconOnly = false,
  fullWidth = false,
}: AddToListButtonProps) {
  const { session } = useAuth()
  const [open, setOpen] = useState(false)

  if (!session) return null

  return (
    <>
      <Button
        size={size}
        iconOnly={iconOnly}
        fullWidth={fullWidth}
        aria-label={iconOnly ? 'Add to a reading list' : undefined}
        startIcon={<Icon name="list" />}
        onClick={() => setOpen(true)}
      >
        {iconOnly ? null : 'Add to list'}
      </Button>
      {open ? (
        <AddToListDialog
          storyId={storyId}
          storyTitle={storyTitle}
          username={session.user.username}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}

function AddToListDialog({
  storyId,
  storyTitle,
  username,
  onClose,
}: {
  storyId: string
  storyTitle: string
  username: string
  onClose: () => void
}) {
  const { showToast } = useToast()

  const lists = useAsync(
    () => listsApi.listReadingLists({ owner: username, storyId, limit: MAX_LISTS_PER_USER }),
    [username, storyId],
  )

  /** What the reader changed here, over what the server said on opening. */
  const [holding, setHolding] = useState<Record<string, boolean>>({})
  const [pending, setPending] = useState<string | null>(null)

  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | undefined>()

  const items = lists.data?.items ?? []

  async function toggle(listId: string, listName: string, has: boolean) {
    setPending(listId)
    try {
      if (has) {
        await listsApi.removeFromList(listId, storyId)
        showToast({ message: `Removed from ${listName}.` })
      } else {
        await listsApi.addToList(listId, storyId)
        showToast({ message: `Added to ${listName}.` })
      }
      setHolding((current) => ({ ...current, [listId]: !has }))
    } catch (cause) {
      showToast({
        tone: 'error',
        message: cause instanceof Error ? cause.message : 'That did not work. Please try again.',
      })
    } finally {
      setPending(null)
    }
  }

  async function createAndAdd() {
    const name = newName.trim()
    if (name.length < 2) {
      setCreateError('Give the list a name.')
      return
    }

    setCreating(true)
    try {
      const list = await listsApi.createReadingList({ name })
      await listsApi.addToList(list.id, storyId)
      setNewName('')
      showToast({ message: `Started ${list.name} with “${storyTitle}”.` })
      lists.reload()
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : 'That list was not created.')
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add to a reading list"
      description={`Choose where “${storyTitle}” belongs.`}
      dismissible={!creating}
      footer={<Button onClick={onClose}>Done</Button>}
    >
      {lists.status === 'error' ? (
        <ErrorState message={lists.error} onRetry={lists.reload} />
      ) : lists.status === 'loading' && !lists.data ? (
        <div className="stack" style={{ gap: 'var(--space-2)' }}>
          <Skeleton height="3.25rem" radius="var(--radius-md)" />
          <Skeleton height="3.25rem" radius="var(--radius-md)" />
        </div>
      ) : items.length === 0 ? (
        <p className="add-to-list__empty">
          You have no reading lists yet. Name one below and this story goes straight on it.
        </p>
      ) : (
        <ul className="add-to-list">
          {items.map((list) => {
            const has = holding[list.id] ?? list.hasStory ?? false
            return (
              <li key={list.id}>
                <button
                  type="button"
                  className={cn('add-to-list__row', has && 'is-on')}
                  aria-pressed={has}
                  disabled={pending !== null}
                  onClick={() => toggle(list.id, list.name, has)}
                >
                  <span className="add-to-list__check" aria-hidden="true">
                    <Icon name={has ? 'check' : 'plus'} size="0.95rem" />
                  </span>
                  <span className="add-to-list__text">
                    <span className="add-to-list__name">{list.name}</span>
                    <span className="add-to-list__meta">
                      {list.isPublic ? null : <Icon name="lock" size="0.8em" />}
                      {list.storyCount} {list.storyCount === 1 ? 'story' : 'stories'}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <form
        className="add-to-list__new"
        onSubmit={(event) => {
          event.preventDefault()
          void createAndAdd()
        }}
      >
        <TextField
          label="New list"
          placeholder="Name a new list"
          value={newName}
          error={createError}
          maxLength={LIST_NAME_MAX}
          disabled={creating}
          onChange={(event) => {
            setNewName(event.target.value)
            setCreateError(undefined)
          }}
        />
        <Button type="submit" loading={creating} startIcon={<Icon name="plus" size="1em" />}>
          Create and add
        </Button>
      </form>

      <p className="add-to-list__foot">
        <Link to="/lists?tab=mine" onClick={onClose}>
          Manage your lists
        </Link>
      </p>
    </Dialog>
  )
}
