import { useState } from 'react'
import { useAuth } from '../../lib/auth'
import { useToast } from '../../lib/toast'
import { useOnline } from '../../lib/network-status'
import {
  canSaveOffline,
  removeSavedStory,
  saveStoryOffline,
  useOffline,
} from '../../lib/offline'
import type { StoryDetail } from '../../types/stories'
import { Button, type ButtonSize } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Icon } from '../ui/Icon'
import './offline.css'

interface SaveOfflineButtonProps {
  story: Pick<StoryDetail, 'id' | 'slug' | 'title' | 'source' | 'status' | 'listedAt'>
  size?: ButtonSize
  /** Icon only, for the reader's top bar. */
  iconOnly?: boolean
  variant?: 'secondary' | 'ghost'
  iconSize?: string
}

/**
 * "Save for offline" on a story's page and in the reader: saves the story's
 * published chapters in this browser (`lib/offline.ts`), and once saved, says
 * so and offers to remove the copy.
 *
 * Nothing for a signed-out visitor, a browser that cannot store, or a story
 * that may not be saved (a draft, a catalogue book).
 */
export function SaveOfflineButton({
  story,
  size = 'lg',
  iconOnly = false,
  variant = 'secondary',
  iconSize,
}: SaveOfflineButtonProps) {
  const { session } = useAuth()
  const { showToast } = useToast()
  const online = useOnline()
  const offline = useOffline()
  const [confirming, setConfirming] = useState(false)
  const [removing, setRemoving] = useState(false)

  if (!session || !offline.supported || !canSaveOffline(story)) return null

  const saved = offline.stories.some((row) => row.storyId === story.id)
  const progress = offline.saving[story.id]

  async function save() {
    try {
      const record = await saveStoryOffline(story.id)
      const count = record.chapters.length
      showToast({
        tone: 'success',
        message: `Saved for offline: ${count} ${count === 1 ? 'chapter' : 'chapters'}. Find it in My Library.`,
      })
    } catch (cause) {
      showToast({
        tone: 'error',
        message: cause instanceof Error ? cause.message : 'That story could not be saved.',
      })
    }
  }

  async function remove() {
    setRemoving(true)
    try {
      await removeSavedStory(story.id)
      setConfirming(false)
      showToast({ message: 'Removed from offline reading.' })
    } catch {
      showToast({ tone: 'error', message: 'The offline copy could not be removed.' })
    } finally {
      setRemoving(false)
    }
  }

  const label = progress
    ? `Saving ${progress.done} of ${progress.total}`
    : saved
      ? 'Saved offline'
      : 'Save for offline'

  return (
    <>
      <Button
        size={size}
        variant={variant}
        iconOnly={iconOnly}
        className={saved ? 'save-offline is-saved' : 'save-offline'}
        aria-label={iconOnly ? (saved ? 'Saved for offline reading' : 'Save for offline reading') : undefined}
        title={iconOnly ? label : undefined}
        aria-pressed={saved}
        loading={progress !== undefined}
        // Saving needs a connection; removing does not.
        disabled={!saved && !online}
        startIcon={<Icon name={saved ? 'check-circle' : 'download'} size={iconSize} />}
        onClick={() => (saved ? setConfirming(true) : void save())}
      >
        {iconOnly ? null : label}
      </Button>

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Remove the offline copy?"
        description={`“${story.title}” will no longer open without a connection.`}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              loading={removing}
              startIcon={<Icon name="trash" size="1em" />}
              onClick={() => void remove()}
            >
              Remove
            </Button>
          </>
        }
      >
        <p className="save-offline__note">
          {online
            ? 'You can save it again any time you are online.'
            : "You're offline, so it can't be saved again until you reconnect."}
        </p>
      </Dialog>
    </>
  )
}
