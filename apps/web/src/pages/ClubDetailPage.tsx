import { useState } from 'react'
import type { CSSProperties } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAsync } from '../hooks/useAsync'
import { useAuth } from '../lib/auth'
import { useToast } from '../lib/toast'
import { hueFor } from '../lib/cover'
import { formatCount, formatDate, formatRelative } from '../lib/format'
import * as clubsApi from '../data/clubs-api'
import {
  CLUB_ROLE_LABELS,
  canModerate,
  clubUserName,
  type Discussion,
} from '../types/clubs'
import { storyAuthorName } from '../types/stories'
import { AppShell } from '../components/layout/AppShell'
import { Avatar } from '../components/ui/Avatar'
import { Button, ButtonLink } from '../components/ui/Button'
import { Card, SectionHead } from '../components/ui/Card'
import { StatusBadge } from '../components/ui/Chip'
import { ConfirmDialog, Dialog } from '../components/ui/Dialog'
import { Icon } from '../components/ui/Icon'
import { Skeleton } from '../components/ui/Skeleton'
import { TextField } from '../components/ui/TextField'
import { EmptyState, ErrorState } from '../components/ui/States'
import { StoryCover } from '../components/story/StoryCover'
import './pages.css'

export function ClubDetailPage() {
  const { slug = '' } = useParams()
  const { session } = useAuth()
  const { showToast } = useToast()
  const navigate = useNavigate()

  /**
   * The signed-in reader, for deciding which posts show a Delete action. Null
   * when signed out — and also in local development, where `readerHeaders()`
   * identifies the caller by header rather than by session, so the action
   * hides rather than guessing wrong.
   */
  const myId = session?.user.id ?? null

  const club = useAsync(() => clubsApi.getClub(slug), [slug])
  const clubId = club.data?.id

  const threads = useAsync(
    () =>
      clubId
        ? clubsApi.getClubDiscussions(clubId, { limit: 20 })
        : Promise.resolve(null),
    [clubId],
  )

  const [pending, setPending] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  /** The thread whose replies are open, and its loaded replies. */
  const [openThreadId, setOpenThreadId] = useState<string | null>(null)
  const replies = useAsync(
    () =>
      clubId && openThreadId
        ? clubsApi.getClubDiscussions(clubId, {
            parentId: openThreadId,
            limit: 50,
          })
        : Promise.resolve(null),
    [clubId, openThreadId],
  )

  const [composeOpen, setComposeOpen] = useState(false)
  const [body, setBody] = useState('')
  const [composeError, setComposeError] = useState<string | undefined>()
  const [posting, setPosting] = useState(false)

  /** Which thread a reply is being written into, keyed by thread id. */
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyBody, setReplyBody] = useState('')

  if (club.status === 'loading') {
    return (
      <AppShell>
        <Skeleton height="12rem" radius="var(--radius-lg)" />
      </AppShell>
    )
  }

  if (club.status === 'error' || !club.data) {
    return (
      <AppShell>
        <ErrorState
          title="We couldn't open that club"
          message={club.error}
          onRetry={club.reload}
        />
      </AppShell>
    )
  }

  const data = club.data
  const isMember = data.membership !== null
  const moderates = canModerate(data)

  async function setMembership(next: boolean) {
    setPending(true)
    try {
      if (next) await clubsApi.joinClub(data.id)
      else await clubsApi.leaveClub(data.id)

      showToast({
        message: next ? `You joined ${data.name}.` : `You left ${data.name}.`,
      })
      club.reload()
    } catch (cause) {
      showToast({
        tone: 'error',
        message:
          cause instanceof Error
            ? cause.message
            : 'That did not work. Please try again.',
      })
    } finally {
      setPending(false)
      setConfirmLeave(false)
    }
  }

  async function onPostThread() {
    const trimmed = body.trim()
    if (trimmed.length === 0) {
      setComposeError('Write something before posting.')
      return
    }

    setPosting(true)
    try {
      await clubsApi.postDiscussion(data.id, { body: trimmed })

      setComposeOpen(false)
      setBody('')
      setComposeError(undefined)
      showToast({ message: 'Thread posted.' })
      threads.reload()
      club.reload()
    } catch (cause) {
      setComposeError(
        cause instanceof Error ? cause.message : 'We could not post that.',
      )
    } finally {
      setPosting(false)
    }
  }

  async function onPostReply(threadId: string) {
    const trimmed = replyBody.trim()
    if (trimmed.length === 0) return

    setPosting(true)
    try {
      await clubsApi.postDiscussion(data.id, {
        body: trimmed,
        parentId: threadId,
      })

      setReplyBody('')
      setReplyTo(null)
      // Open the thread so the new reply is visible where it landed.
      setOpenThreadId(threadId)
      replies.reload()
      threads.reload()
    } catch (cause) {
      showToast({
        tone: 'error',
        message:
          cause instanceof Error ? cause.message : 'We could not post that reply.',
      })
    } finally {
      setPosting(false)
    }
  }

  async function onDeleteThread(thread: Discussion) {
    try {
      await clubsApi.deleteDiscussion(thread.id)
      showToast({ message: 'Post deleted.' })
      threads.reload()
      replies.reload()
      club.reload()
    } catch (cause) {
      showToast({
        tone: 'error',
        message:
          cause instanceof Error ? cause.message : 'We could not delete that.',
      })
    }
  }

  async function onClearCurrentRead() {
    try {
      await clubsApi.setCurrentRead(data.id, null)
      showToast({ message: 'Current read cleared.' })
      club.reload()
    } catch (cause) {
      showToast({
        tone: 'error',
        message:
          cause instanceof Error
            ? cause.message
            : 'We could not change the current read.',
      })
    }
  }

  async function onDeleteClub() {
    setPending(true)
    try {
      await clubsApi.deleteClub(data.id)
      showToast({ message: `${data.name} was deleted.` })
      navigate('/clubs')
    } catch (cause) {
      showToast({
        tone: 'error',
        message:
          cause instanceof Error
            ? cause.message
            : 'We could not delete that club.',
      })
    } finally {
      setPending(false)
      setConfirmDelete(false)
    }
  }

  return (
    <AppShell>
      {/*
        `clubs.BookClub` has no hue column — the mock's was invented — so the
        banner colour is derived from the slug. Deterministic, so the club keeps
        its colour across reloads.
      */}
      <header
        className="club-hero"
        style={{ '--club-hue': hueFor(data.slug) } as CSSProperties}
      >
        <div className="club-hero__banner" aria-hidden="true" />

        <div className="club-hero__body">
          <div className="club-hero__head">
            <div>
              <div className="club-hero__badges">
                {/*
                  Every club is open: there is no invite or approval flow in the
                  contract, so a "private club" badge would describe nothing.
                */}
                <StatusBadge tone="success">Open club</StatusBadge>
                {data.membership ? (
                  <StatusBadge tone="brand">
                    {CLUB_ROLE_LABELS[data.membership.role]}
                  </StatusBadge>
                ) : null}
              </div>

              <h1 className="club-hero__title">{data.name}</h1>
              {data.description ? (
                <p className="club-hero__desc">{data.description}</p>
              ) : null}
            </div>

            <div className="club-hero__actions">
              {isMember ? (
                <Button
                  loading={pending}
                  onClick={() => setConfirmLeave(true)}
                  startIcon={<Icon name="check" size="1em" />}
                >
                  Joined
                </Button>
              ) : (
                <Button
                  variant="primary"
                  loading={pending}
                  onClick={() => setMembership(true)}
                  startIcon={<Icon name="user-plus" size="1em" />}
                >
                  Join club
                </Button>
              )}
              <Button iconOnly aria-label="Share this club" startIcon={<Icon name="share" />} />
            </div>
          </div>

          <dl className="club-hero__facts">
            <div>
              <dt>Members</dt>
              <dd>{formatCount(data.memberCount)}</dd>
            </div>
            <div>
              <dt>Discussions</dt>
              <dd>{formatCount(data.discussionCount)}</dd>
            </div>
            <div>
              <dt>Founded</dt>
              <dd>{formatDate(data.createdAt)}</dd>
            </div>
            <div>
              <dt>Owner</dt>
              <dd>
                {data.owner ? (
                  <Link to={`/profile/${data.owner.username}`}>
                    {clubUserName(data.owner)}
                  </Link>
                ) : (
                  '—'
                )}
              </dd>
            </div>
          </dl>
        </div>
      </header>

      <div className="club-layout">
        <div>
          <section className="page-section">
            <SectionHead
              title="Discussions"
              action={
                isMember ? (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => setComposeOpen(true)}
                    startIcon={<Icon name="plus" size="0.95em" />}
                  >
                    New thread
                  </Button>
                ) : undefined
              }
            />

            {threads.status === 'error' ? (
              <ErrorState message={threads.error} onRetry={threads.reload} />
            ) : threads.status === 'loading' ? (
              <div className="row-list">
                {Array.from({ length: 3 }, (_, index) => (
                  <Skeleton key={index} height="7rem" radius="var(--radius-lg)" />
                ))}
              </div>
            ) : (threads.data?.items.length ?? 0) === 0 ? (
              <EmptyState
                icon="comment"
                title="No discussions yet"
                description={
                  isMember
                    ? 'Start the first thread — everyone in the club can reply.'
                    : 'Join the club to start the first thread.'
                }
                action={
                  isMember ? (
                    <Button variant="primary" onClick={() => setComposeOpen(true)}>
                      New thread
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <ul className="discussion-list">
                {threads.data?.items.map((thread) => {
                  const open = openThreadId === thread.id

                  return (
                    <li className="discussion" key={thread.id}>
                      <Avatar user={thread.user} size="md" />
                      <div className="discussion__body">
                        {/*
                          No title column on `ClubDiscussion`, so the body is
                          the thread. The mock's separate title and body were
                          two fields for one thing.
                        */}
                        <p className="discussion__meta">
                          {clubUserName(thread.user)} ·{' '}
                          {formatRelative(thread.createdAt)}
                        </p>
                        <p className="discussion__text">{thread.body}</p>
                        <p className="discussion__foot">
                          <span>
                            <Icon name="comment" size="0.9em" />
                            {formatCount(thread.replyCount)}{' '}
                            {thread.replyCount === 1 ? 'reply' : 'replies'}
                          </span>
                          {thread.replyCount > 0 ? (
                            <button
                              type="button"
                              onClick={() =>
                                setOpenThreadId(open ? null : thread.id)
                              }
                            >
                              {open ? 'Hide replies' : 'Show replies'}
                            </button>
                          ) : null}
                          {isMember ? (
                            <button
                              type="button"
                              onClick={() => {
                                setReplyTo(replyTo === thread.id ? null : thread.id)
                                setReplyBody('')
                              }}
                            >
                              Reply
                            </button>
                          ) : null}
                          {/*
                            Shown only to people the API would actually let
                            delete it: the author, or a club moderator. A
                            button that always 403s is worse than no button.
                          */}
                          {moderates || thread.user.id === myId ? (
                            <button
                              type="button"
                              onClick={() => onDeleteThread(thread)}
                            >
                              Delete
                            </button>
                          ) : null}
                        </p>

                        {open ? (
                          replies.status === 'loading' ? (
                            <Skeleton height="4rem" radius="var(--radius-md)" />
                          ) : (
                            <ul className="discussion-replies">
                              {replies.data?.items.map((reply) => (
                                <li key={reply.id}>
                                  <Avatar user={reply.user} size="sm" />
                                  <div>
                                    <p className="discussion__meta">
                                      {clubUserName(reply.user)} ·{' '}
                                      {formatRelative(reply.createdAt)}
                                    </p>
                                    <p className="discussion__text">{reply.body}</p>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          )
                        ) : null}

                        {replyTo === thread.id ? (
                          <div className="discussion__reply-form">
                            <TextField
                              multiline
                              hideLabel
                              label={`Reply to ${clubUserName(thread.user)}`}
                              placeholder="Write a reply…"
                              rows={3}
                              value={replyBody}
                              maxLength={5000}
                              disabled={posting}
                              onChange={(event) => setReplyBody(event.target.value)}
                            />
                            <div className="discussion__reply-actions">
                              <Button
                                size="sm"
                                onClick={() => setReplyTo(null)}
                                disabled={posting}
                              >
                                Cancel
                              </Button>
                              <Button
                                size="sm"
                                variant="primary"
                                loading={posting}
                                onClick={() => onPostReply(thread.id)}
                              >
                                Post reply
                              </Button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </div>

        <aside className="club-side">
          {data.currentStory ? (
            <Card>
              <p className="club-side__label">Currently reading</p>
              <div className="club-side__story">
                <Link to={`/story/${data.currentStory.slug}`} tabIndex={-1} aria-hidden="true">
                  <StoryCover story={data.currentStory} size="sm" />
                </Link>
                <div>
                  <h3>
                    <Link to={`/story/${data.currentStory.slug}`}>
                      {data.currentStory.title}
                    </Link>
                  </h3>
                  <p>{storyAuthorName(data.currentStory.author)}</p>
                </div>
              </div>
              {data.currentStory.chapterCount > 0 ? (
                <ButtonLink
                  variant="primary"
                  fullWidth
                  to={`/read/${data.currentStory.slug}/1`}
                  startIcon={<Icon name="book-open" size="1em" />}
                >
                  Read along
                </ButtonLink>
              ) : null}
              {moderates ? (
                <Button fullWidth variant="ghost" onClick={onClearCurrentRead}>
                  Clear current read
                </Button>
              ) : null}
            </Card>
          ) : moderates ? (
            <Card>
              <p className="club-side__label">Currently reading</p>
              <p className="club-side__hint">
                Nothing set. Open a story and pick “Set as club read” — or set it
                from the club’s own page once that action lands.
              </p>
            </Card>
          ) : null}

          <Card>
            <p className="club-side__label">Moderators</p>
            <ul className="club-side__people">
              {data.moderators.length === 0 ? (
                <li>
                  <span>
                    <strong>No moderators</strong>
                  </span>
                </li>
              ) : (
                data.moderators.map((member) => (
                  <li key={member.user.id}>
                    <Avatar user={member.user} size="sm" />
                    <span>
                      <strong>{clubUserName(member.user)}</strong>
                      <span>{CLUB_ROLE_LABELS[member.role]}</span>
                    </span>
                  </li>
                ))
              )}
            </ul>
          </Card>

          {moderates ? (
            <Card>
              <p className="club-side__label">Manage</p>
              <Button
                fullWidth
                variant="danger"
                onClick={() => setConfirmDelete(true)}
              >
                Delete club
              </Button>
            </Card>
          ) : null}
        </aside>
      </div>

      <Dialog
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        title="New thread"
        description={`Everyone in ${data.name} can read and reply.`}
        dismissible={!posting}
        footer={
          <>
            <Button onClick={() => setComposeOpen(false)} disabled={posting}>
              Cancel
            </Button>
            <Button variant="primary" loading={posting} onClick={onPostThread}>
              Post thread
            </Button>
          </>
        }
      >
        <TextField
          multiline
          label="Thread"
          placeholder="What do you want to talk about?"
          rows={6}
          value={body}
          error={composeError}
          maxLength={5000}
          counterMax={5000}
          disabled={posting}
          onChange={(event) => {
            setBody(event.target.value)
            setComposeError(undefined)
          }}
        />
      </Dialog>

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${data.name}?`}
        message="Every thread and reply in the club goes with it. This cannot be undone."
        confirmLabel="Delete club"
        pending={pending}
        onConfirm={onDeleteClub}
        onCancel={() => setConfirmDelete(false)}
      />

      <ConfirmDialog
        open={confirmLeave}
        title={`Leave ${data.name}?`}
        message="You'll stop seeing this club's threads in your feed. You can rejoin any time."
        confirmLabel="Leave club"
        pending={pending}
        onConfirm={() => setMembership(false)}
        onCancel={() => setConfirmLeave(false)}
      />
    </AppShell>
  )
}
