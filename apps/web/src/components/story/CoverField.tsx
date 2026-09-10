import { useRef, useState } from 'react'
import {
  ACCEPTED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  uploadImage,
} from '../../data/uploads-api'
import { ApiError } from '../../lib/api-client'
import { formatFileSize } from '../../lib/format'
import { useObjectUrl } from '../../lib/object-url'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { StoryCover } from './StoryCover'
import './story.css'

/** Just enough of a story to draw its cover, uploaded or generated. */
interface CoverStory {
  id: string
  title: string
  coverUrl?: string | null
  genres: Array<{ hue: number }>
  author: { displayName?: string | null; username?: string }
}

interface CoverFieldProps {
  story: CoverStory
  /**
   * Saves the new URL — or null to clear it. Called after the bytes are
   * stored, because the upload and the row that points at it are two steps:
   * this component owns the first and the form owns the second.
   */
  onChange: (coverUrl: string | null) => Promise<void>
  /** Set while the form is busy, so the cover cannot change mid-save. */
  disabled?: boolean
}

/**
 * A story's cover: preview, choose, remove.
 *
 * Unlike the settings avatar — which stages a file for the profile form to
 * save with everything else — a cover commits as soon as it is chosen. The
 * editor autosaves anyway, so staging it would mean holding a file back from a
 * form that is otherwise always saved, and an author who changes their mind
 * has "Remove" right there.
 *
 * The local file is shown the moment it is picked, so the preview does not
 * wait on the round trip; it is dropped once the saved URL comes back.
 *
 * Kept separate from `settings/AvatarField.tsx` on purpose. The two look like
 * the same picker-preview-upload job, but the commit rule above is only the
 * first of the differences: the avatar runs a chosen file through
 * `AvatarCropper`, offers a `Lightbox` and an Undo of the staged change, and
 * previews an `Avatar`, where a cover previews a `StoryCover` and falls back
 * to generated art. Folding them together turns every one of those into a
 * prop and leaves perhaps twenty shared lines — a hidden input and two
 * guards — behind an interface wider than either component. What they do
 * share is the validation data, and that already lives in one place:
 * `data/uploads-api.ts` and `data/account-api.ts` own the caps and the
 * accepted types, and `lib/format.ts` formats them.
 */
export function CoverField({ story, onChange, disabled = false }: CoverFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  const [picked, setPicked] = useState<File | null>(null)
  const [busy, setBusy] = useState<'uploading' | 'removing' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const previewUrl = useObjectUrl(picked)
  const shown = previewUrl ?? story.coverUrl ?? null

  async function onPick(file: File | undefined) {
    // Reset the input, or picking the same file twice fires no change event.
    if (inputRef.current) inputRef.current.value = ''
    if (!file || disabled || busy !== null) return

    setError(null)

    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      setError('Use a PNG, JPEG, WebP or GIF image.')
      return
    }

    if (file.size > MAX_IMAGE_BYTES) {
      setError(
        `That image is too large. Pick one under ${formatFileSize(MAX_IMAGE_BYTES)}.`,
      )
      return
    }

    setPicked(file)
    setBusy('uploading')
    try {
      const stored = await uploadImage(file)
      await onChange(stored.url)
    } catch (cause) {
      // The local preview would otherwise keep showing a cover that was never
      // saved, which reads as success.
      setPicked(null)
      setError(
        cause instanceof ApiError
          ? (cause.fieldErrors.file ?? cause.message)
          : 'We could not upload that image.',
      )
    } finally {
      setBusy(null)
      setPicked(null)
    }
  }

  async function onRemove() {
    setError(null)
    setBusy('removing')
    try {
      await onChange(null)
      setPicked(null)
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : 'We could not remove that cover.',
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="cover-field">
      <StoryCover story={{ ...story, coverUrl: shown }} size="lg" />

      <div className="cover-field__side">
        <p className="cover-field__note">
          {shown
            ? 'Readers see this on every shelf and on your story page.'
            : 'Covers are generated from your title and genre until you upload artwork.'}
        </p>

        <input
          ref={inputRef}
          className="visually-hidden"
          type="file"
          id="story-cover"
          accept={ACCEPTED_IMAGE_TYPES.join(',')}
          disabled={disabled || busy !== null}
          onChange={(event) => void onPick(event.target.files?.[0])}
        />

        <div className="cover-field__actions">
          <Button
            size="sm"
            loading={busy === 'uploading'}
            disabled={disabled || busy !== null}
            onClick={() => inputRef.current?.click()}
            startIcon={<Icon name="upload" size="0.95em" />}
          >
            {shown ? 'Replace cover' : 'Upload cover'}
          </Button>

          {story.coverUrl ? (
            <Button
              size="sm"
              variant="ghost"
              loading={busy === 'removing'}
              disabled={disabled || busy !== null}
              onClick={() => void onRemove()}
              startIcon={<Icon name="trash" size="0.95em" />}
            >
              Remove
            </Button>
          ) : null}
        </div>

        <p className="cover-field__hint">
          PNG, JPEG, WebP or GIF, up to {formatFileSize(MAX_IMAGE_BYTES)}. Portrait
          artwork at 2:3 fits the frame without cropping.
        </p>

        {error ? (
          <p className="cover-field__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  )
}
