import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAsync } from '../../hooks/useAsync'
import { useAuth } from '../../lib/auth'
import { useToast } from '../../lib/toast'
import { formatCount, formatRelative } from '../../lib/format'
import * as api from '../../data/api'
import { AppShell } from '../../components/layout/AppShell'
import { Button } from '../../components/ui/Button'
import { Card, SectionHead, StatTile } from '../../components/ui/Card'
import { Dialog } from '../../components/ui/Dialog'
import { Icon } from '../../components/ui/Icon'
import { Skeleton } from '../../components/ui/Skeleton'
import { TextField } from '../../components/ui/TextField'
import { EmptyState, ErrorState } from '../../components/ui/States'
import '../pages.css'
import './author.css'

export function AuthorChannelsPage() {
  const { session } = useAuth()
  const authorId = session?.user.id ?? 'u-me'
  const { showToast } = useToast()

  const channels = useAsync(() => api.getChannels(), [])
  const mine = channels.data?.filter((channel) => channel.authorId === authorId) ?? []
  const primary = mine[0]

  const posts = useAsync(
    () => (primary ? api.getChannelPosts(primary.id) : Promise.resolve([])),
    [primary?.id],
  )

  const [composeOpen, setComposeOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [errors, setErrors] = useState<{ title?: string; body?: string }>({})
  const [posting, setPosting] = useState(false)

  async function onPost() {
    const next: typeof errors = {}
    if (title.trim().length === 0) next.title = 'Give the post a title.'
    if (body.trim().length === 0) next.body = 'Write something before posting.'
    setErrors(next)
    if (Object.keys(next).length > 0) return

    setPosting(true)
    try {
      await new Promise((resolve) => setTimeout(resolve, 600))
      setComposeOpen(false)
      setTitle('')
      setBody('')
      showToast({ message: 'Post published to your subscribers.' })
      posts.reload()
    } catch {
      showToast({ tone: 'error', message: 'We could not publish that post.' })
    } finally {
      setPosting(false)
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
            onClick={() => setComposeOpen(true)}
            startIcon={<Icon name="plus" size="1em" />}
          >
            New post
          </Button>
        ) : (
          <Button variant="primary" startIcon={<Icon name="plus" size="1em" />}>
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
          action={<Button variant="primary">Create your channel</Button>}
        />
      ) : (
        <>
          <div className="stat-row">
            <StatTile
              label="Subscribers"
              value={formatCount(primary.subscriberCount)}
              detail="+186 this month"
              trend="up"
              icon="users"
            />
            <StatTile label="Posts" value={String(primary.postCount)} icon="megaphone" />
            <StatTile label="Avg. likes" value="2.4K" icon="heart" />
            <StatTile label="Open rate" value="61%" icon="eye" />
          </div>

          <section className="page-section">
            <SectionHead
              title={primary.name}
              subtitle={primary.description}
              action={
                <Link className="section-head__link" to={`/channels/${primary.slug}`}>
                  View public channel
                  <Icon name="arrow-up-right" size="0.85em" />
                </Link>
              }
            />

            {posts.data?.length === 0 ? (
              <EmptyState size="sm" icon="megaphone" title="No posts yet" />
            ) : (
              <ul className="row-list">
                {posts.data?.map((post) => (
                  <li key={post.id}>
                    <Card as="article" className="author-post">
                      <div className="author-post__head">
                        <h3>{post.title}</h3>
                        <span>{formatRelative(post.publishedAt)}</span>
                      </div>
                      <p className="author-post__body">{post.body.split('\n\n')[0]}</p>
                      <div className="author-post__foot">
                        <span>
                          <Icon name="heart" size="0.9em" />
                          {formatCount(post.likeCount)}
                        </span>
                        <span>
                          <Icon name="comment" size="0.9em" />
                          {formatCount(post.commentCount)}
                        </span>
                        <Button variant="ghost" size="sm">
                          Edit
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
        title="New channel post"
        description={`Goes to ${formatCount(primary?.subscriberCount ?? 0)} subscribers.`}
        dismissible={!posting}
        footer={
          <>
            <Button onClick={() => setComposeOpen(false)} disabled={posting}>
              Cancel
            </Button>
            <Button variant="primary" loading={posting} onClick={onPost}>
              Publish post
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
            maxLength={120}
            counterMax={120}
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
            maxLength={5000}
            counterMax={5000}
            disabled={posting}
            onChange={(event) => {
              setBody(event.target.value)
              setErrors((current) => ({ ...current, body: undefined }))
            }}
          />
        </div>
      </Dialog>
    </AppShell>
  )
}
