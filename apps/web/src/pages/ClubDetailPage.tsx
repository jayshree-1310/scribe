import { useState } from 'react'
import type { CSSProperties } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAsync } from '../hooks/useAsync'
import { useToast } from '../lib/toast'
import { formatCount, formatDate, formatRelative } from '../lib/format'
import * as api from '../data/api'
import { AppShell } from '../components/layout/AppShell'
import { Avatar } from '../components/ui/Avatar'
import { Button, ButtonLink } from '../components/ui/Button'
import { Card, SectionHead } from '../components/ui/Card'
import { GenreChip, StatusBadge } from '../components/ui/Chip'
import { ConfirmDialog } from '../components/ui/Dialog'
import { Icon } from '../components/ui/Icon'
import { Skeleton } from '../components/ui/Skeleton'
import { EmptyState, ErrorState } from '../components/ui/States'
import { StoryCover } from '../components/story/StoryCover'
import './pages.css'

export function ClubDetailPage() {
  const { slug = '' } = useParams()
  const { showToast } = useToast()

  const club = useAsync(() => api.getClub(slug), [slug])
  const clubId = club.data?.id
  const threads = useAsync(
    () => (clubId ? api.getClubDiscussions(clubId) : Promise.resolve([])),
    [clubId],
  )

  const [joined, setJoined] = useState<boolean | null>(null)
  const [pending, setPending] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)

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
        <ErrorState title="We couldn't open that club" message={club.error} onRetry={club.reload} />
      </AppShell>
    )
  }

  const data = club.data
  const isMember = joined ?? data.membership !== null

  async function setMembership(next: boolean) {
    setPending(true)
    try {
      await new Promise((resolve) => setTimeout(resolve, 450))
      setJoined(next)
      showToast({
        message: next ? `You joined ${data.name}.` : `You left ${data.name}.`,
      })
    } catch {
      showToast({ tone: 'error', message: 'That did not work. Please try again.' })
    } finally {
      setPending(false)
      setConfirmLeave(false)
    }
  }

  return (
    <AppShell>
      <header className="club-hero" style={{ '--club-hue': data.hue } as CSSProperties}>
        <div className="club-hero__banner" aria-hidden="true" />

        <div className="club-hero__body">
          <div className="club-hero__head">
            <div>
              <div className="club-hero__badges">
                {data.isPrivate ? (
                  <StatusBadge tone="plum" icon={<Icon name="lock" size="0.8em" />}>
                    Private club
                  </StatusBadge>
                ) : (
                  <StatusBadge tone="success">Open club</StatusBadge>
                )}
                {data.genres.map((genre) => (
                  <GenreChip key={genre.id} genre={genre} asLink />
                ))}
              </div>

              <h1 className="club-hero__title">{data.name}</h1>
              <p className="club-hero__desc">{data.description}</p>
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
                <Link to={`/profile/${data.owner.username}`}>{data.owner.displayName}</Link>
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
                <Button size="sm" variant="primary" startIcon={<Icon name="plus" size="0.95em" />}>
                  New thread
                </Button>
              }
            />

            {threads.status === 'error' ? (
              <ErrorState message={threads.error} onRetry={threads.reload} />
            ) : threads.data?.length === 0 ? (
              <EmptyState icon="comment" title="No discussions yet" />
            ) : (
              <ul className="discussion-list">
                {threads.data?.map((thread) => (
                  <li className="discussion" key={thread.id}>
                    <Avatar user={thread.user} size="md" />
                    <div className="discussion__body">
                      <h3>{thread.title}</h3>
                      <p className="discussion__meta">
                        {thread.user.displayName} · {formatRelative(thread.createdAt)}
                        {thread.chapterNumber ? (
                          <>
                            {' · '}
                            <span className="discussion__anchor">
                              Chapter {thread.chapterNumber}
                            </span>
                          </>
                        ) : null}
                      </p>
                      <p className="discussion__text">{thread.body}</p>
                      <p className="discussion__foot">
                        <span>
                          <Icon name="comment" size="0.9em" />
                          {formatCount(thread.replyCount)} replies
                        </span>
                        <button type="button">Reply</button>
                      </p>
                    </div>
                  </li>
                ))}
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
                  <p>{data.currentStory.author.displayName}</p>
                </div>
              </div>
              <ButtonLink
                variant="primary"
                fullWidth
                to={`/read/${data.currentStory.slug}/1`}
                startIcon={<Icon name="book-open" size="1em" />}
              >
                Read along
              </ButtonLink>
            </Card>
          ) : null}

          <Card>
            <p className="club-side__label">Moderators</p>
            <ul className="club-side__people">
              <li>
                <Avatar user={data.owner} size="sm" />
                <span>
                  <strong>{data.owner.displayName}</strong>
                  <span>Owner</span>
                </span>
              </li>
            </ul>
          </Card>
        </aside>
      </div>

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
