import { useEffect, useRef, useState } from 'react'
import {
  ACCEPTED_AVATAR_TYPES,
  MAX_AVATAR_BYTES,
  removeAvatar,
  uploadAvatar,
  type AccountProfile,
} from '../../data/account-api'
import { ApiError } from '../../lib/api-client'
import { useToast } from '../../lib/toast'
import { Avatar } from '../ui/Avatar'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Lightbox } from '../ui/Lightbox'
import type { User } from '../../types/domain'

interface AvatarFieldProps {
  user: User
  /** Called with the profile the API returns, so the session stays in step. */
  onChange: (profile: AccountProfile) => void
}

function readableSize(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

/**
 * Profile picture: preview, upload, remove.
 *
 * The preview is the picture the API has, not a local object URL of the chosen
 * file — a preview that swaps ahead of the response would claim a save that
 * may still fail. The one exception is the in-flight upload, where the file is
 * shown behind a spinner so the wait has something to look at.
 */
export function AvatarField({ user, onChange }: AvatarFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const { showToast } = useToast()

  const [pending, setPending] = useState<'upload' | 'remove' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [viewing, setViewing] = useState(false)

  // Object URLs are a document-lifetime leak until revoked.
  useEffect(() => {
    if (!preview) return
    return () => URL.revokeObjectURL(preview)
  }, [preview])

  const shown = preview ?? user.avatarUrl ?? null

  async function onPick(file: File | undefined) {
    // Reset the input, or picking the same file twice fires no change event.
    if (inputRef.current) inputRef.current.value = ''
    if (!file || pending) return

    setError(null)

    if (!ACCEPTED_AVATAR_TYPES.includes(file.type)) {
      setError('Use a PNG, JPEG, WebP or GIF image.')
      return
    }

    if (file.size > MAX_AVATAR_BYTES) {
      setError(`That image is too large. Pick one under ${readableSize(MAX_AVATAR_BYTES)}.`)
      return
    }

    const objectUrl = URL.createObjectURL(file)
    setPreview(objectUrl)
    setPending('upload')

    try {
      onChange(await uploadAvatar(file))
      showToast({ message: 'Profile picture updated.' })
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? (cause.fieldErrors['avatar'] ?? cause.message)
          : "We couldn't upload that picture.",
      )
    } finally {
      // Either way the API's copy is now the truth: on success it is the file
      // just uploaded, on failure it is the old picture.
      setPreview(null)
      setPending(null)
    }
  }

  async function onRemove() {
    if (pending) return

    setError(null)
    setPending('remove')

    try {
      onChange(await removeAvatar())
      showToast({ message: 'Profile picture removed.' })
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : "We couldn't remove that picture.",
      )
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="avatar-field">
      {shown ? (
        <button
          type="button"
          className="avatar-field__preview"
          onClick={() => setViewing(true)}
          aria-label="View your profile picture"
          data-pending={pending === 'upload' ? '' : undefined}
        >
          <Avatar user={{ ...user, avatarUrl: shown }} size="xl" />
        </button>
      ) : (
        <Avatar user={{ ...user, avatarUrl: null }} size="xl" />
      )}

      <div className="avatar-field__body">
        <p className="avatar-field__hint">
          A square image works best. PNG, JPEG, WebP or GIF, up to{' '}
          {readableSize(MAX_AVATAR_BYTES)}.
        </p>

        <div className="avatar-field__actions">
          <Button
            onClick={() => inputRef.current?.click()}
            loading={pending === 'upload'}
            disabled={pending !== null}
            startIcon={<Icon name="upload" size="1em" />}
          >
            {user.avatarUrl ? 'Change picture' : 'Upload picture'}
          </Button>

          {user.avatarUrl ? (
            <Button
              variant="ghost"
              onClick={onRemove}
              loading={pending === 'remove'}
              disabled={pending !== null}
              startIcon={<Icon name="trash" size="1em" />}
            >
              Remove
            </Button>
          ) : null}
        </div>

        {error ? (
          <p className="avatar-field__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <input
        ref={inputRef}
        type="file"
        className="visually-hidden"
        accept={ACCEPTED_AVATAR_TYPES.join(',')}
        // Labelled by the button that opens it; the input itself is never seen.
        aria-label="Choose a profile picture"
        onChange={(event) => void onPick(event.target.files?.[0])}
      />

      {shown ? (
        <Lightbox
          open={viewing}
          onClose={() => setViewing(false)}
          src={shown}
          alt="Your profile picture"
        />
      ) : null}
    </div>
  )
}
