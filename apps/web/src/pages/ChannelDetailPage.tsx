import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAsync } from '../hooks/useAsync'
import { useToast } from '../lib/toast'
import { formatCount, formatDate, formatRelative } from '../lib/format'
import * as channelsApi from '../data/channels-api'
import { channelAuthorName, type ChannelPost } from '../types/channels'
import { paragraphsOf } from '../types/stories'
import { AppShell } from '../components/layout/AppShell'
import { Avatar } from '../components/ui/Avatar'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Icon } from '../components/ui/Icon'
import { Skeleton } from '../components/ui/Skeleton'
import { EmptyState, ErrorState } from '../components/ui/States'
import './pages.css'

/** Posts per page in the feed. */
const PAGE_SIZE = 10

export function ChannelDetailPage() {
  const { slug = '' } = useParams()
  const { showToast } = useToast()

  const channel = useAsync(() => channelsApi.getChannel(slug), [slug])

  /**
   * The feed accumulates across "Load older posts" rather than paging back and
   * forth: a channel reads as one chronological wall.
   *
   * Hand-rolled rather than `useAsync`, and shaped after `DiscoverPage`'s
   * paginated list: the reset on a channel change happens during render, so a
   * page in flight for the previous channel can never be appended to this
   * one's results, and the append happens where the response lands rather than
   * in an effect reacting to it.
   */
  const [query, setQuery] = useState({ slug, page: 1 })
  const [loaded, setLoaded] = useState<ChannelPost[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [feedStatus, setFeedStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  )
  const [feedError, setFeedError] = useState<string | null>(null)

  if (query.slug !== slug) {
    setQuery({ slug, page: 1 })
    setLoaded([])
    setHasMore(false)
    setFeedStatus('loading')
    setFeedError(null)
  }

  useEffect(() => {
    let active = true

    channelsApi
      .getChannelPosts(query.slug, { page: query.page, limit: PAGE_SIZE })
      .then((page) => {
        if (!active) return

        setLoaded((current) =>
          query.page === 1 ? page.items : [...current, ...page.items],
        )
        setHasMore(page.hasMore)
        setFeedStatus('ready')
        setFeedError(null)
      })
      .catch((cause: unknown) => {
        if (!active) return

        setFeedStatus('error')
        setFeedError(
          cause instanceof Error ? cause.message : 'Those posts did not load.',
        )
      })

    return () => {
      active = false
    }
  }, [query])

  function reloadFeed() {
    setFeedStatus('loading')
    setFeedError(null)
    setQuery((current) => ({ ...current }))
  }

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
  const authorName = channelAuthorName(data.author)

  async function toggle() {
    setPending(true)
    const next = !data.subscribed
    try {
      if (next) await channelsApi.subscribe(data.id)
      else await channelsApi.unsubscribe(data.id)

      showToast({
        message: next
          ? `Subscribed to ${data.name}.`
          : `Unsubscribed from ${data.name}.`,
      })
      // Re-read rather than toggling locally: the subscriber count moves too,
      // and the server is the only thing that knows its real value.
      channel.reload()
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
              by <Link to={`/profile/${data.author.username}`}>{authorName}</Link>
            </p>
            <p className="channel-hero__stats">
              <span>
                <Icon name="users" size="0.9em" />
                {formatCount(data.subscriberCount)} subscribers
              </span>
              <span>
                <Icon name="megaphone" size="0.9em" />
                {formatCount(data.postCount)} posts
              </span>
              <span>
                <Icon name="calendar" size="0.9em" />
                Since {formatDate(data.createdAt)}
              </span>
            </p>
          </div>
        </div>

        {data.description ? (
          <p className="channel-hero__desc">{data.description}</p>
        ) : null}

        <div className="channel-hero__actions">
          <Button
            variant={data.subscribed ? 'secondary' : 'primary'}
            size="lg"
            loading={pending}
            onClick={toggle}
            startIcon={<Icon name={data.subscribed ? 'check' : 'bell'} />}
          >
            {data.subscribed ? 'Subscribed' : 'Subscribe'}
          </Button>
          <Button size="lg" iconOnly aria-label="Share channel" startIcon={<Icon name="share" />} />
        </div>
      </header>

      {/*
        Every branch below is gated on the accumulated feed being empty, so
        loading page two shows a spinner on the button rather than replacing
        the posts already on screen with skeletons.
      */}
      {feedStatus === 'error' && loaded.length === 0 ? (
        <ErrorState message={feedError} onRetry={reloadFeed} />
      ) : feedStatus === 'loading' && loaded.length === 0 ? (
        <div className="row-list">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} height="9rem" radius="var(--radius-lg)" />
          ))}
        </div>
      ) : loaded.length === 0 ? (
        <EmptyState
          icon="megaphone"
          title="No posts yet"
          description={`${authorName} hasn't posted here yet. Subscribe and you'll see the first one.`}
        />
      ) : (
        <>
          <ul className="post-feed">
            {loaded.map((post) => (
              <li key={post.id}>
                <Card as="article" className="post">
                  <header className="post__head">
                    <Avatar user={data.author} size="sm" />
                    <div>
                      <p className="post__author">{authorName}</p>
                      <p className="post__when">
                        {formatRelative(post.postedAt)}
                        {/*
                          `updatedAt` diverges from `postedAt` only once the
                          post has been edited, so this is the honest way to
                          say so without a separate column.
                        */}
                        {post.updatedAt !== post.postedAt ? ' · edited' : ''}
                      </p>
                    </div>
                  </header>

                  <h2 className="post__title">{post.title}</h2>

                  {paragraphsOf(post.content).map((paragraph, index) => (
                    <p className="post__body" key={index}>
                      {paragraph}
                    </p>
                  ))}
                </Card>
              </li>
            ))}
          </ul>

          {feedStatus === 'error' ? (
            <div className="post-feed__more">
              <ErrorState message={feedError} onRetry={reloadFeed} />
            </div>
          ) : hasMore ? (
            <div className="post-feed__more">
              <Button
                loading={feedStatus === 'loading'}
                onClick={() => {
                  setFeedStatus('loading')
                  setQuery((current) => ({ ...current, page: current.page + 1 }))
                }}
              >
                Load older posts
              </Button>
            </div>
          ) : null}
        </>
      )}
    </AppShell>
  )
}
