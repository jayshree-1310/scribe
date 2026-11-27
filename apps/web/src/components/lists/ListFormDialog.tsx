import { useState } from 'react'
import * as listsApi from '../../data/reading-lists-api'
import { Button } from '../ui/Button'
import { Switch } from '../ui/Checkbox'
import { Dialog } from '../ui/Dialog'
import { TextField } from '../ui/TextField'
import {
  LIST_DESCRIPTION_MAX,
  LIST_NAME_MAX,
  type ReadingList,
  type ReadingListDetail,
} from '../../types/reading-lists'

interface ListFormDialogProps {
  open: boolean
  onClose: () => void
  /** The list being edited, or null to start a new one. */
  list: ReadingList | null
  onSaved: (list: ReadingListDetail) => void
}

/**
 * Starting or editing a reading list: its name, what it is for, and who can
 * see it. One dialog for both, the way `ChannelsPage` and
 * `AuthorChannelsPage` share a shape.
 *
 * Mounted fresh for each opening (the callers key it), so the fields start
 * from the list in hand rather than from whatever was typed last time.
 */
export function ListFormDialog({ open, onClose, list, onSaved }: ListFormDialogProps) {
  const [name, setName] = useState(list?.name ?? '')
  const [description, setDescription] = useState(list?.description ?? '')
  const [isPublic, setIsPublic] = useState(list?.isPublic ?? true)
  const [error, setError] = useState<string | undefined>()
  const [saving, setSaving] = useState(false)

  async function onSubmit() {
    const trimmed = name.trim()
    if (trimmed.length < 2) {
      setError('Give the list a name.')
      return
    }

    setSaving(true)
    try {
      const input = { name: trimmed, description: description.trim() || null, isPublic }
      const saved = list
        ? await listsApi.updateReadingList(list.id, input)
        : await listsApi.createReadingList(input)
      onSaved(saved)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That list was not saved.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={list ? 'Edit list' : 'New reading list'}
      description={
        list
          ? undefined
          : 'Collect stories around a theme and share your taste. Add stories from any story page.'
      }
      dismissible={!saving}
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={onSubmit}>
            {list ? 'Save changes' : 'Create list'}
          </Button>
        </>
      }
    >
      <form
        className="stack"
        style={{ gap: 'var(--space-5)' }}
        onSubmit={(event) => {
          event.preventDefault()
          void onSubmit()
        }}
      >
        <TextField
          label="Name"
          placeholder="Best slow-burn fantasy"
          value={name}
          error={error}
          maxLength={LIST_NAME_MAX}
          counterMax={LIST_NAME_MAX}
          disabled={saving}
          autoFocus
          onChange={(event) => {
            setName(event.target.value)
            setError(undefined)
          }}
        />
        <TextField
          multiline
          label="Description"
          placeholder="What ties these stories together?"
          rows={3}
          value={description}
          maxLength={LIST_DESCRIPTION_MAX}
          counterMax={LIST_DESCRIPTION_MAX}
          disabled={saving}
          onChange={(event) => setDescription(event.target.value)}
        />
        <Switch
          checked={isPublic}
          onChange={setIsPublic}
          label="Public"
          description={
            isPublic
              ? 'Anyone can find this list, open it and follow it.'
              : 'Only you can see this list. Anyone already following it hears nothing until it is public again.'
          }
        />
        {/* Lets Enter submit from the name field. */}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
