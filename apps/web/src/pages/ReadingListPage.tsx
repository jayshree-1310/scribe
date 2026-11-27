import { useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useAsync } from '../hooks/useAsync'
import { useAuth } from '../lib/auth'
import { useToast } from '../lib/toast'
import { formatCount, formatRelative } from '../lib/format'
import * as listsApi from '../data/reading-lists-api'
import { ReportMenu } from '../components/moderation/ReportMenu'
import { Avatar } from '../components/ui/Avatar'
import { Button, ButtonLink } from '../components/ui/Button'
import { StatusBadge } from '../components/ui/Chip'
import { ConfirmDialog } from '../components/ui/Dialog'
import { Icon } from '../components/ui/Icon'
import { Skeleton } from '../components/ui/Skeleton'
import { EmptyState, ErrorState } from '../components/ui/States'
import { TextField } from '../components/ui/TextField'
import { StoryCover } from '../components/story/StoryCover'
import { ListFormDialog } from '../components/lists/ListFormDialog'
import {
  LIST_NOTE_MAX,
  MAX_ENTRIES_PER_LIST,
  ownerName,
  storyHref,
  type FollowListState,
  type ListEntry,
} from '../types/reading-lists'
import '../components/lists/lists.css'
import './pages.css'

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'That did not work. Please try again.'
}

/**
 * One reading list: who made it, what it is for, and its stories with the
 * curator's notes, newest first. The owner edits it here -- name, privacy,
 * notes, removing a story -- and everybody else can follow, share or report.
 */
export function ReadingListPage() {
  const { slug = '' } = useParams()
  const { session } = useAuth()
  const { showToast } = useToast()
  const navigate = useNavigate()
  const location = useLocation()

  const list = useAsync(() => listsApi.getReadingList(slug), [slug])

  /** The follow button's state after a write; null while the list's own holds. */
  const [follow, setFollow] = useState<{ slug: string; state: FollowListState } | null>(null)
  const [followBusy, setFollowBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editKey, setEditKey] = useState(0)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  if (list.status === 'loading' && !list.data) {
    return (
      <div className="stack" style={{ gap: 'var(--space-5)' }}>
        <Skeleton height="10rem" radius="var(--radius-lg)" />
        <Skeleton height="7rem" radius="var(--radius-lg)" />
      </div>
    )
  }

  if (list.status === 'error' || !list.data) {
    return (
      <ErrorState
        title="We couldn't open that list"
        message={list.error}
        onRetry={list.reload}
      />
    )
  }

  const data = list.data
  const current = follow?.slug === data.slug ? follow.state : null
  const following = current?.following ?? data.following
  const followerCount = current?.followerCount ?? data.followerCount
  const curator = ownerName(data.owner)

  async function toggleFollow() {
    setFollowBusy(true)
    try {
      const state = following
        ? await listsApi.unfollowList(data.id)
        : await listsApi.followList(data.id)
      setFollow({ slug: data.slug, state })
      showToast({
        message: state.following ? `Following ${data.name}.` : `Stopped following ${data.name}.`,
      })
    } catch (cause) {
      showToast({ tone: 'error', message: messageOf(cause) })
    } finally {
      setFollowBusy(false)
    }
  }

  async function onShare() {
    const url = window.location.href
    try {
      if (navigator.share) {
        await navigator.share({ title: data.name, url })
        return
      }
      await navigator.clipboard.writeText(url)
      showToast({ message: 'Link copied to your clipboard.' })
    } catch {
      showToast({ tone: 'error', message: 'We could not share that link.' })
    }
  }

  async function onDelete() {
    setDeleting(true)
    setDeleteError(null)
    try {
      await listsApi.deleteReadingList(data.id)
      showToast({ message: `Deleted ${data.name}.` })
      navigate('/lists?tab=mine', { replace: true })
    } catch (cause) {
      setDeleteError(messageOf(cause))
      setDeleting(false)
    }
  }

  return (
    <>
      <header className="channel-hero list-hero">
        <div className="channel-hero__head">
          <Avatar user={data.owner} size="xl" />
          <div className="channel-hero__ident">
            <p className="list-hero__kicker">
              <Icon name="list" size="0.95em" />
              Reading list
              {data.isPublic ? null : (
                <StatusBadge icon={<Icon name="lock" size="0.85em" />}>Private</StatusBadge>
              )}
            </p>
            <h1>{data.name}</h1>
            <p className="channel-hero__author">
              by <Link to={`/profile/${data.owner.username}`}>{curator}</Link>
            </p>
            <p className="channel-hero__stats">
              <span>
                <Icon name="book" size="0.9em" />
                {formatCount(data.storyCount)} {data.storyCount === 1 ? 'story' : 'stories'}
              </span>
              {data.isPublic ? (
                <span>
                  <Icon name="users" size="0.9em" />
                  {formatCount(followerCount)} {followerCount === 1 ? 'follower' : 'followers'}
                </span>
              ) : null}
              <span>
                <Icon name="clock" size="0.9em" />
                Updated {formatRelative(data.updatedAt)}
              </span>
            </p>
          </div>
        </div>

        {data.description ? <p className="channel-hero__desc">{data.description}</p> : null}

        <div className="channel-hero__actions">
          {data.isOwner ? (
            <>
              <Button
                size="lg"
                startIcon={<Icon name="pencil" />}
                onClick={() => {
                  setEditKey((key) => key + 1)
                  setEditing(true)
                }}
              >
                Edit list
              </Button>
              <Button
                size="lg"
                variant="ghost"
                startIcon={<Icon name="trash" />}
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </Button>
            </>
          ) : session ? (
            <Button
              variant={following ? 'secondary' : 'primary'}
              size="lg"
              loading={followBusy}
              onClick={toggleFollow}
              startIcon={<Icon name={following ? 'check' : 'bell'} />}
            >
              {following ? 'Following' : 'Follow'}
            </Button>
          ) : (
            <ButtonLink
              variant="primary"
              size="lg"
              to="/login"
              // Back here after signing in, the contract `RequireAuth` uses.
              state={{ from: location.pathname }}
              startIcon={<Icon name="bell" />}
            >
              Sign in to follow
            </ButtonLink>
          )}
          {data.isPublic ? (
            <Button
              size="lg"
              iconOnly
              aria-label="Share list"
              startIcon={<Icon name="share" />}
              onClick={onShare}
            />
          ) : null}
          <ReportMenu
            targetType="READING_LIST"
            targetId={data.id}
            noun="list"
            size="lg"
            hidden={!session || data.isOwner}
          />
        </div>
      </header>

      {data.entries.length === 0 ? (
        data.isOwner ? (
          <EmptyState
            icon="list"
            title="Nothing on this list yet"
            description="Open any story or book and choose Add to list. You can write a note on each one here."
            action={<ButtonLink to="/discover">Find stories</ButtonLink>}
          />
        ) : (
          <EmptyState
            icon="list"
            title="Nothing on this list yet"
            description={`${curator} hasn't added anything here yet.`}
          />
        )
      ) : (
        <ol className="list-entries">
          {data.entries.map((entry) => (
            <EntryRow
              key={entry.id}
              entry={entry}
              listId={data.id}
              editable={data.isOwner}
              onChanged={list.reload}
            />
          ))}
        </ol>
      )}

      {data.isOwner && data.entries.length > 0 ? (
        <p className="list-entries__foot">
          {data.entries.length} of {MAX_ENTRIES_PER_LIST} places used. Add more from any story's
          page with Add to list.
        </p>
      ) : null}

      {data.isOwner ? (
        <>
          <ListFormDialog
            key={editKey}
            open={editing}
            onClose={() => setEditing(false)}
            list={data}
            onSaved={() => {
              setEditing(false)
              showToast({ message: 'List saved.' })
              list.reload()
            }}
          />
          <ConfirmDialog
            open={confirmDelete}
            title="Delete this list?"
            message={`“${data.name}” and its notes will be gone for good${
              followerCount > 0 ? `, and its ${followerCount} ${followerCount === 1 ? 'follower' : 'followers'} will stop seeing it` : ''
            }. The stories themselves are not affected.`}
            confirmLabel="Delete list"
            pending={deleting}
            error={deleteError}
            onConfirm={onDelete}
            onCancel={() => {
              setConfirmDelete(false)
              setDeleteError(null)
            }}
          />
        </>
      ) : null}
    </>
  )
}

/**
 * One story on the list, with the curator's note. The owner can write or
 * change the note in place, and take the story off.
 */
function EntryRow({
  entry,
  listId,
  editable,
  onChanged,
}: {
  entry: ListEntry
  listId: string
  editable: boolean
  onChanged: () => void
}) {
  const { showToast } = useToast()
  const { story } = entry
  const href = storyHref(story)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(entry.note ?? '')
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(false)

  async function saveNote() {
    setSaving(true)
    try {
      await listsApi.updateListNote(listId, story.id, draft.trim() || null)
      setEditing(false)
      onChanged()
    } catch (cause) {
      showToast({ tone: 'error', message: messageOf(cause) })
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    setRemoving(true)
    try {
      await listsApi.removeFromList(listId, story.id)
      showToast({ message: `Removed “${story.title}”.` })
      onChanged()
    } catch (cause) {
      showToast({ tone: 'error', message: messageOf(cause) })
      setRemoving(false)
    }
  }

  return (
    <li className="list-entry">
      <Link className="list-entry__cover" to={href} tabIndex={-1} aria-hidden="true">
        <StoryCover story={story} size="sm" />
      </Link>

      <div className="list-entry__body">
        <h2 className="shelf-item__title">
          <Link to={href}>{story.title}</Link>
        </h2>
        <p className="shelf-item__author">
          by {story.author.displayName || story.author.username}
          {story.genres[0] ? ` · ${story.genres[0].name}` : ''}
        </p>

        {editing ? (
          <form
            className="list-entry__note-form"
            onSubmit={(event) => {
              event.preventDefault()
              void saveNote()
            }}
          >
            <TextField
              multiline
              label="Your note"
              hideLabel
              placeholder="Why is this one on the list?"
              rows={3}
              value={draft}
              maxLength={LIST_NOTE_MAX}
              counterMax={LIST_NOTE_MAX}
              disabled={saving}
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="list-entry__note-actions">
              <Button
                size="sm"
                onClick={() => {
                  setDraft(entry.note ?? '')
                  setEditing(false)
                }}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button size="sm" variant="primary" type="submit" loading={saving}>
                Save note
              </Button>
            </div>
          </form>
        ) : entry.note ? (
          <blockquote className="list-entry__note">{entry.note}</blockquote>
        ) : null}

        <p className="shelf-item__added">Added {formatRelative(entry.addedAt)}</p>
      </div>

      {editable && !editing ? (
        <div className="list-entry__actions">
          <Button
            size="sm"
            variant="ghost"
            startIcon={<Icon name="pen" size="1em" />}
            onClick={() => {
              setDraft(entry.note ?? '')
              setEditing(true)
            }}
          >
            {entry.note ? 'Edit note' : 'Add note'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            aria-label={`Remove “${story.title}” from the list`}
            loading={removing}
            startIcon={<Icon name="close" size="1em" />}
            onClick={remove}
          />
        </div>
      ) : null}
    </li>
  )
}
