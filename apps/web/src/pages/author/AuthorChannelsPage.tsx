import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAsync } from '../../hooks/useAsync'
import { useToast } from '../../lib/toast'
import { formatCount, formatRelative } from '../../lib/format'
import * as channelsApi from '../../data/channels-api'
import type { ChannelPost } from '../../types/channels'
import { AppShell } from '../../components/layout/AppShell'
import { Button } from '../../components/ui/Button'
import { Card, SectionHead, StatTile } from '../../components/ui/Card'
import { ConfirmDialog, Dialog } from '../../components/ui/Dialog'
import { Icon } from '../../components/ui/Icon'
import { Skeleton } from '../../components/ui/Skeleton'
import { TextField } from '../../components/ui/TextField'
import { EmptyState, ErrorState } from '../../components/ui/States'
import '../pages.css'
import './author.css'

export function AuthorChannelsPage() {
  const { showToast } = useToast()

  /**
   * The caller's own channels, filtered server-side rather than by comparing
   * ids in the browser: ownership is the API's to decide, and `mine=true` is
   * the endpoint that answers it.
   */
  const channels = useAsync(
    () => channelsApi.listChannels({ mine: true, limit: 24 }),
    [],
  )

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const mine = channels.data?.items ?? []
  // Falls back to the first channel until the author picks one.
  const primary = mine.find((channel) => channel.id === selectedId) ?? mine[0]

  const posts = useAsync(
    () =>
      primary
        ? channelsApi.getChannelPosts(primary.id, { limit: 20 })
        : Promise.resolve(null),
    [primary?.id],
  )

  /* Compose / edit ------------------------------------------------------- */

  const [composeOpen, setComposeOpen] = useState(false)
  /** The post being edited, or null when composing a new one. */
  const [editing, setEditing] = useState<ChannelPost | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [errors, setErrors] = useState<{ title?: string; body?: string }>({})
  const [posting, setPosting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<ChannelPost | null>(null)

  /* Create a channel ----------------------------------------------------- */

  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [createError, setCreateError] = useState<string | undefined>()
  const [creating, setCreating] = useState(false)

  function openCompose(post: ChannelPost | null) {
    setEditing(post)
    setTitle(post?.title ?? '')
    setBody(post?.content ?? '')
    setErrors({})
    setComposeOpen(true)
  }

  async function onPost() {
    if (!primary) return

    const next: typeof errors = {}
    if (title.trim().length === 0) next.title = 'Give the post a title.'
    if (body.trim().length === 0) next.body = 'Write something before posting.'
    setErrors(next)
    if (Object.keys(next).length > 0) return

    setPosting(true)
    try {
      if (editing) {
        await channelsApi.updatePost(editing.id, {
          title: title.trim(),
          content: body.trim(),
        })
        showToast({ message: 'Post updated.' })
      } else {
        await channelsApi.createPost(primary.id, {
          title: title.trim(),
          content: body.trim(),
        })
        showToast({ message: 'Post published to your subscribers.' })
      }

      setComposeOpen(false)
      setEditing(null)
      setTitle('')
      setBody('')
      posts.reload()
      channels.reload()
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : 'We could not publish that post.'
      setErrors({ body: message })
    } finally {
      setPosting(false)
    }
  }

  async function onDeletePost(post: ChannelPost) {
    setPosting(true)
    try {
      await channelsApi.deletePost(post.id)
      showToast({ message: 'Post deleted.' })
      posts.reload()
      channels.reload()
    } catch (cause) {
      showToast({
        tone: 'error',
        message:
          cause instanceof Error ? cause.message : 'We could not delete that.',
      })
    } finally {
      setPosting(false)
      setConfirmDelete(null)
    }
  }

  async function onCreateChannel() {
    const trimmed = name.trim()
    if (trimmed.length < 2) {
      setCreateError('Give the channel a name.')
      return
    }

    setCreating(true)
    try {
      const channel = await channelsApi.createChannel({
        name: trimmed,
        description: description.trim() || null,
      })

      setCreateOpen(false)
      setName('')
      setDescription('')
      setCreateError(undefined)
      setSelectedId(channel.id)
      showToast({ message: `${channel.name} is live.` })
      channels.reload()
    } catch (cause) {
      setCreateError(
        cause instanceof Error
          ? cause.message
          : 'We could not create that channel.',
      )
    } finally {
      setCreating(false)
    }
  }

  return (
    <AppShell variant="author">
      <header className="page-head">
        <div>
          <h1 className="page-head__title">Broadcast channels</h1>
          <p className="page-head__sub">
            Your direct line to readers between chapters.
          </p>
        </div>
        {primary ? (
          <Button
            variant="primary"
            onClick={() => openCompose(null)}
            startIcon={<Icon name="plus" size="1em" />}
          >
            New post
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={() => setCreateOpen(true)}
            startIcon={<Icon name="plus" size="1em" />}
          >
            Create a channel
          </Button>
        )}
      </header>

      {channels.status === 'error' ? (
        <ErrorState message={channels.error} onRetry={channels.reload} />
      ) : channels.status === 'loading' ? (
        <Skeleton height="14rem" radius="var(--radius-lg)" />
      ) : !primary ? (
        <EmptyState
          icon="megaphone"
          title="You don't have a channel yet"
          description="Channels let you post release notes, cut scenes and progress updates to readers who opted in."
          action={
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              Create your channel
            </Button>
          }
        />
      ) : (
        <>
          {/*
            Three tiles, not four: the mock's "avg. likes" and "open rate" had
            nothing behind them -- a channel records no likes and no reads --
            so what is left is what the API actually counts.
          */}
          <div className="stat-row">
            <StatTile
              label="Subscribers"
              value={formatCount(primary.subscriberCount)}
              icon="users"
            />
            <StatTile
              label="Posts"
              value={formatCount(primary.postCount)}
              icon="megaphone"
            />
            <StatTile
              label="Last posted"
              value={
                posts.data?.items[0]
                  ? formatRelative(posts.data.items[0].postedAt)
                  : '—'
              }
              icon="clock"
            />
          </div>

          {/* More than one channel: pick which to manage. */}
          {mine.length > 1 ? (
            <div className="chip-row" style={{ marginBottom: 'var(--space-6)' }}>
              {mine.map((channel) => (
                <Button
                  key={channel.id}
                  size="sm"
                  variant={channel.id === primary.id ? 'primary' : 'subtle'}
                  onClick={() => setSelectedId(channel.id)}
                >
                  {channel.name}
                </Button>
              ))}
            </div>
          ) : null}

          <section className="page-section">
            <SectionHead
              title={primary.name}
              subtitle={primary.description ?? undefined}
              action={
                <Link className="section-head__link" to={`/channels/${primary.slug}`}>
                  View public channel
                  <Icon name="arrow-up-right" size="0.85em" />
                </Link>
              }
            />

            {posts.status === 'error' ? (
              <ErrorState message={posts.error} onRetry={posts.reload} />
            ) : posts.status === 'loading' ? (
              <div className="row-list">
                {Array.from({ length: 3 }, (_, index) => (
                  <Skeleton key={index} height="7rem" radius="var(--radius-lg)" />
                ))}
              </div>
            ) : (posts.data?.items.length ?? 0) === 0 ? (
              <EmptyState
                size="sm"
                icon="megaphone"
                title="No posts yet"
                description="Your subscribers see everything you post here."
                action={
                  <Button variant="primary" onClick={() => openCompose(null)}>
                    Write your first post
                  </Button>
                }
              />
            ) : (
              <ul className="row-list">
                {posts.data?.items.map((post) => (
                  <li key={post.id}>
                    <Card as="article" className="author-post">
                      <div className="author-post__head">
                        <h3>{post.title}</h3>
                        <span>
                          {formatRelative(post.postedAt)}
                          {post.updatedAt !== post.postedAt ? ' · edited' : ''}
                        </span>
                      </div>
                      <p className="author-post__body">
                        {post.content.split(/\n{2,}/)[0]}
                      </p>
                      <div className="author-post__foot">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openCompose(post)}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setConfirmDelete(post)}
                        >
                          Delete
                        </Button>
                      </div>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <Dialog
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        title={editing ? 'Edit post' : 'New channel post'}
        description={
          editing
            ? 'Your subscribers see the revised post; it keeps its place in the feed.'
            : `Goes to ${formatCount(primary?.subscriberCount ?? 0)} subscribers.`
        }
        dismissible={!posting}
        footer={
          <>
            <Button onClick={() => setComposeOpen(false)} disabled={posting}>
              Cancel
            </Button>
            <Button variant="primary" loading={posting} onClick={onPost}>
              {editing ? 'Save changes' : 'Publish post'}
            </Button>
          </>
        }
      >
        <div className="stack" style={{ gap: 'var(--space-5)' }}>
          <TextField
            label="Title"
            placeholder="Chapter 15 is live"
            value={title}
            error={errors.title}
            maxLength={200}
            counterMax={200}
            disabled={posting}
            onChange={(event) => {
              setTitle(event.target.value)
              setErrors((current) => ({ ...current, title: undefined }))
            }}
          />
          <TextField
            multiline
            label="Post"
            placeholder="What should your readers know?"
            rows={8}
            value={body}
            error={errors.body}
            maxLength={20000}
            counterMax={20000}
            disabled={posting}
            onChange={(event) => {
              setBody(event.target.value)
              setErrors((current) => ({ ...current, body: undefined }))
            }}
          />
        </div>
      </Dialog>

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create a channel"
        description="Readers who subscribe will see everything you post here."
        dismissible={!creating}
        footer={
          <>
            <Button onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button variant="primary" loading={creating} onClick={onCreateChannel}>
              Create channel
            </Button>
          </>
        }
      >
        <div className="stack" style={{ gap: 'var(--space-5)' }}>
          <TextField
            label="Name"
            placeholder="Notes from the Coast"
            value={name}
            error={createError}
            maxLength={120}
            counterMax={120}
            disabled={creating}
            onChange={(event) => {
              setName(event.target.value)
              setCreateError(undefined)
            }}
          />
          <TextField
            multiline
            label="Description"
            placeholder="What will you post here?"
            rows={4}
            value={description}
            maxLength={2000}
            counterMax={2000}
            disabled={creating}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
      </Dialog>

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete this post?"
        message="Your subscribers will no longer see it. This cannot be undone."
        confirmLabel="Delete post"
        pending={posting}
        onConfirm={() => confirmDelete && onDeletePost(confirmDelete)}
        onCancel={() => setConfirmDelete(null)}
      />
    </AppShell>
  )
}
