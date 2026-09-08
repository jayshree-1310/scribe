import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAsync } from '../hooks/useAsync'
import { useToast } from '../lib/toast'
import { formatCount, formatDate, formatRelative } from '../lib/format'
import * as api from '../data/api'
import { AppShell } from '../components/layout/AppShell'
import { Avatar } from '../components/ui/Avatar'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Icon } from '../components/ui/Icon'
import { Skeleton } from '../components/ui/Skeleton'
import { EmptyState, ErrorState } from '../components/ui/States'
import './pages.css'

export function ChannelDetailPage() {
  const { slug = '' } = useParams()
  const { showToast } = useToast()

  const channel = useAsync(() => api.getChannel(slug), [slug])
  const channelId = channel.data?.id
  const posts = useAsync(
    () => (channelId ? api.getChannelPosts(channelId) : Promise.resolve([])),
    [channelId],
  )

  const [subscribed, setSubscribed] = useState<boolean | null>(null)
  const [pending, setPending] = useState(false)

  if (channel.status === 'loading') {
    return (
      <AppShell width="narrow">
        <Skeleton height="10rem" radius="var(--radius-lg)" />
      </AppShell>
    )
  }

  if (channel.status === 'error' || !channel.data) {
    return (
      <AppShell width="narrow">
        <ErrorState
          title="We couldn't open that channel"
          message={channel.error}
          onRetry={channel.reload}
        />
      </AppShell>
    )
  }

  const data = channel.data
  const isSubscribed = subscribed ?? data.subscribed

  async function toggle() {
    setPending(true)
    try {
      await new Promise((resolve) => setTimeout(resolve, 400))
      const next = !isSubscribed
      setSubscribed(next)
      showToast({
        message: next
          ? `Subscribed to ${data.name}.`
          : `Unsubscribed from ${data.name}.`,
      })
    } finally {
      setPending(false)
    }
  }

  return (
    <AppShell width="narrow">
      <header className="channel-hero">
        <div className="channel-hero__head">
          <Avatar user={data.author} size="xl" />
          <div className="channel-hero__ident">
            <h1>{data.name}</h1>
            <p className="channel-hero__author">
              by{' '}
              <Link to={`/profile/${data.author.username}`}>{data.author.displayName}</Link>
            </p>
            <p className="channel-hero__stats">
              <span>
                <Icon name="users" size="0.9em" />
                {formatCount(isSubscribed ? data.subscriberCount + 1 : data.subscriberCount)}{' '}
                subscribers
              </span>
              <span>
                <Icon name="megaphone" size="0.9em" />
                {data.postCount} posts
              </span>
              <span>
                <Icon name="calendar" size="0.9em" />
                Since {formatDate(data.createdAt)}
              </span>
            </p>
          </div>
        </div>

        <p className="channel-hero__desc">{data.description}</p>

        <div className="channel-hero__actions">
          <Button
            variant={isSubscribed ? 'secondary' : 'primary'}
            size="lg"
            loading={pending}
            onClick={toggle}
            startIcon={<Icon name={isSubscribed ? 'check' : 'bell'} />}
          >
            {isSubscribed ? 'Subscribed' : 'Subscribe'}
          </Button>
          <Button size="lg" iconOnly aria-label="Share channel" startIcon={<Icon name="share" />} />
        </div>
      </header>

      {posts.status === 'error' ? (
        <ErrorState message={posts.error} onRetry={posts.reload} />
      ) : posts.status === 'loading' ? (
        <div className="row-list">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} height="9rem" radius="var(--radius-lg)" />
          ))}
        </div>
      ) : posts.data?.length === 0 ? (
        <EmptyState icon="megaphone" title="No posts yet" />
      ) : (
        <ul className="post-feed">
          {posts.data?.map((post) => (
            <li key={post.id}>
              <Card as="article" className="post">
                <header className="post__head">
                  <Avatar user={data.author} size="sm" />
                  <div>
                    <p className="post__author">{data.author.displayName}</p>
                    <p className="post__when">{formatRelative(post.publishedAt)}</p>
                  </div>
                </header>

                <h2 className="post__title">{post.title}</h2>

                {post.body.split('\n\n').map((paragraph, index) => (
                  <p className="post__body" key={index}>
                    {paragraph}
                  </p>
                ))}

                {post.linkedStoryId ? (
                  <Link className="post__link" to="/story/saltglass">
                    <Icon name="book-open" size="0.95em" />
                    Read the chapter
                  </Link>
                ) : null}

                <footer className="post__foot">
                  <button type="button">
                    <Icon name="heart" size="0.95em" />
                    {formatCount(post.likeCount)}
                  </button>
                  <button type="button">
                    <Icon name="comment" size="0.95em" />
                    {formatCount(post.commentCount)}
                  </button>
                  <button type="button">
                    <Icon name="share" size="0.95em" />
                    Share
                  </button>
                </footer>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  )
}
