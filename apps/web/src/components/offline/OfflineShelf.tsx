import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useToast } from '../../lib/toast'
import { useOnline } from '../../lib/network-status'
import { formatFileSize, formatRelative } from '../../lib/format'
import {
  COPY_LIFETIME_DAYS,
  MAX_SAVED_STORIES,
  daysSinceChecked,
  removeSavedStory,
  useOffline,
  type SavedStory,
} from '../../lib/offline'
import { storyAuthorName } from '../../types/stories'
import { StoryCover } from '../story/StoryCover'
import { BookCardSkeleton } from '../books/BookCard'
import { Button, ButtonLink } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Icon } from '../ui/Icon'
import { EmptyState, InlineNotice } from '../ui/States'
import './offline.css'

/** Where a saved story opens: the place last kept on this device, else its start. */
function resumeLink(row: SavedStory): { to: string; chapter: number; resumes: boolean } {
  const kept = row.position?.chapterNumber
  const resumes = kept !== undefined && row.chapters.some((chapter) => chapter.number === kept)
  const chapter = resumes ? kept : (row.chapters[0]?.number ?? 1)
  return { to: `/read/${row.slug}/${chapter}`, chapter, resumes }
}

/**
 * Safari on iPhone and iPad deletes a site's storage after seven days of use
 * without a visit, unless the site was added to the Home Screen.
 */
function onIosBrowser(): boolean {
  if (typeof navigator === 'undefined') return false
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const installed =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  return ios && !installed
}

/**
 * My Library's Offline shelf: the stories this account saved in this
 * browser, with the space each takes, and a way to remove them. Read from
 * the device, so it opens with no connection.
 */
export function OfflineShelf() {
  const offline = useOffline()
  const online = useOnline()
  const { showToast } = useToast()
  const [removing, setRemoving] = useState<SavedStory | null>(null)
  const [busy, setBusy] = useState(false)

  if (!offline.supported) {
    return (
      <EmptyState
        icon="cloud-off"
        title="This browser can't keep stories offline"
        description="Offline reading needs browser storage, which is turned off here (a private window, or blocked site data)."
      />
    )
  }

  if (!offline.ready) {
    return (
      <div className="shelf-list" aria-busy="true">
        {Array.from({ length: 2 }, (_, index) => (
          <BookCardSkeleton key={index} variant="row" />
        ))}
      </div>
    )
  }

  if (offline.stories.length === 0) {
    return (
      <EmptyState
        icon="download"
        title="Nothing saved for offline yet"
        description="Save a story from its page or the reader, and you can read it here with no connection: on a train, a flight, or anywhere the signal drops."
        action={online ? <ButtonLink to="/discover">Find a story</ButtonLink> : undefined}
      />
    )
  }

  async function confirmRemove() {
    if (!removing) return
    setBusy(true)
    try {
      await removeSavedStory(removing.storyId)
      showToast({ message: `Removed “${removing.story.title}” from offline reading.` })
      setRemoving(null)
    } catch {
      showToast({ tone: 'error', message: 'The offline copy could not be removed.' })
    } finally {
      setBusy(false)
    }
  }

  const used = offline.stories.reduce((sum, row) => sum + row.bytes, 0)

  return (
    <>
      <div className="shelf-list">
        {offline.stories.map((row) => {
          const resume = resumeLink(row)
          const count = row.chapters.length
          const unchecked = daysSinceChecked(row)
          const expired = unchecked >= COPY_LIFETIME_DAYS

          return (
            <article className="shelf-item" key={row.storyId}>
              <Link
                className="shelf-item__cover"
                to={resume.to}
                tabIndex={-1}
                aria-hidden="true"
              >
                <StoryCover story={row.story} size="sm" />
              </Link>

              <div className="shelf-item__body">
                <h3 className="shelf-item__title">
                  <Link to={resume.to}>{row.story.title}</Link>
                </h3>
                <p className="shelf-item__author">{storyAuthorName(row.story.author)}</p>
                <p className="shelf-item__added">
                  {count} {count === 1 ? 'chapter' : 'chapters'} · {formatFileSize(row.bytes)} ·
                  Saved {formatRelative(row.savedAt)}
                </p>
                {expired ? (
                  <p className="offline-item__warn">
                    <Icon name="alert" size="0.95em" />
                    Not checked for {unchecked} days. Connect to the internet to keep
                    reading it.
                  </p>
                ) : null}
              </div>

              <div className="shelf-item__actions">
                <ButtonLink
                  size="sm"
                  variant="primary"
                  to={resume.to}
                  startIcon={<Icon name="book-open" size="1em" />}
                >
                  {resume.resumes ? `Continue · Ch. ${resume.chapter}` : 'Read'}
                </ButtonLink>
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  aria-label={`Remove “${row.story.title}” from offline reading`}
                  title="Remove offline copy"
                  startIcon={<Icon name="trash" size="1em" />}
                  onClick={() => setRemoving(row)}
                />
              </div>
            </article>
          )
        })}
      </div>

      <div className="offline-shelf__foot">
        <p>
          {offline.stories.length} of {MAX_SAVED_STORIES} stories · {formatFileSize(used)} on
          this device. Saved stories stay in this browser only, and signing out removes them.
          Pictures, audio and video in a chapter are not saved.
        </p>
        {offline.persisted === false ? (
          <InlineNotice>
            Your browser may clear saved stories if this device runs low on space.
          </InlineNotice>
        ) : null}
        {onIosBrowser() ? (
          <InlineNotice>
            On iPhone and iPad, Safari removes saved stories after a week without a
            visit. Add Scribe to your Home Screen (Share → Add to Home Screen) to keep them.
          </InlineNotice>
        ) : null}
      </div>

      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="Remove the offline copy?"
        description={
          removing ? `“${removing.story.title}” will no longer open without a connection.` : undefined
        }
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              loading={busy}
              startIcon={<Icon name="trash" size="1em" />}
              onClick={() => void confirmRemove()}
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
