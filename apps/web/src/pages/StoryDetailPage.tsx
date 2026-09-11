import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAsync } from '../hooks/useAsync'
import { useToast } from '../lib/toast'
import { coverWash } from '../lib/cover'
import {
  formatCount,
  formatDate,
  formatMinutes,
  formatRating,
  formatRelative,
} from '../lib/format'
import * as stories from '../data/stories-api'
import * as engagement from '../data/engagement-api'
import {
  STORY_STATUS_LABELS,
  readingMinutes,
  storyAuthorName,
} from '../types/stories'
import {
  COMMENT_MAX_LENGTH,
  commentUserName,
  type Comment,
} from '../types/engagement'
import { useAuth } from '../lib/auth'
import { AppShell } from '../components/layout/AppShell'
import { Avatar } from '../components/ui/Avatar'
import { Button, ButtonLink } from '../components/ui/Button'
import { Card, SectionHead } from '../components/ui/Card'
import { GenreChip, StatusBadge } from '../components/ui/Chip'
import { Dialog } from '../components/ui/Dialog'
import { Icon } from '../components/ui/Icon'
import { RatingInput, Stars } from '../components/ui/Rating'
import { Skeleton } from '../components/ui/Skeleton'
import { Tabs, TabPanel } from '../components/ui/Tabs'
import { TextField } from '../components/ui/TextField'
import { EmptyState, ErrorState } from '../components/ui/States'
import { StoryCard, StoryCardSkeleton } from '../components/story/StoryCard'
import { StoryCover } from '../components/story/StoryCover'
import { RatingBars } from '../components/charts/RatingBars'
import './pages.css'
import './story-detail.css'

type DetailTab = 'chapters' | 'reviews' | 'comments'

const TABS = [
  { id: 'chapters' as const, label: 'Chapters' },
  { id: 'reviews' as const, label: 'Reviews' },
  { id: 'comments' as const, label: 'Comments' },
]

export function StoryDetailPage() {
  const { slug = '' } = useParams()
  const { showToast } = useToast()
  const { session } = useAuth()

  /**
   * Null in local development, where `readerHeaders()` identifies the caller
   * by header rather than by session -- so the Delete action below hides
   * rather than guessing wrong, the same trade `ClubDetailPage` makes.
   */
  const myId = session?.user.id ?? null

  const story = useAsync(() => stories.getStory(slug), [slug])
  const storyId = story.data?.id

  const chapters = useAsync(
    () => (storyId ? stories.getChapters(storyId) : Promise.resolve([])),
    [storyId],
  )
  const similar = useAsync(
    () => (storyId ? stories.getRelatedStories(storyId) : Promise.resolve([])),
    [storyId],
  )

  /**
   * The breakdown, the caller's own score, and the comment thread all come
   * from `engagement-api`. Loaded separately from the story rather than
   * folded into it: the header needs the story to render at all, while a slow
   * ratings query should only hold up the bars it draws.
   */
  const ratings = useAsync(
    () => (storyId ? engagement.getRatings(storyId) : Promise.resolve(null)),
    [storyId],
  )
  const comments = useAsync(
    () =>
      storyId
        ? engagement.listComments(storyId, { limit: 20 })
        : Promise.resolve(null),
    [storyId],
  )

  /** The thread whose replies are open, and its loaded replies. */
  const [openThreadId, setOpenThreadId] = useState<string | null>(null)
  const replies = useAsync(
    () =>
      storyId && openThreadId
        ? engagement.listComments(storyId, {
            parentId: openThreadId,
            limit: 50,
          })
        : Promise.resolve(null),
    [storyId, openThreadId],
  )

  const [tab, setTab] = useState<DetailTab>('chapters')
  const [inLibrary, setInLibrary] = useState(false)
  const [rateOpen, setRateOpen] = useState(false)
  const [score, setScore] = useState(0)
  const [ratingError, setRatingError] = useState<string | null>(null)
  const [savingRating, setSavingRating] = useState(false)
  const [commentBody, setCommentBody] = useState('')
  const [commentError, setCommentError] = useState<string | null>(null)
  const [posting, setPosting] = useState(false)

  /** Which thread a reply is being written into. */
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyBody, setReplyBody] = useState('')

  if (story.status === 'loading') {
    return (
      <AppShell>
        <div className="detail__loading">
          <Skeleton width="9rem" height="13.5rem" radius="var(--radius-sm)" />
          <div className="stack" style={{ gap: 'var(--space-3)', flex: 1 }}>
            <Skeleton width="60%" height="2rem" />
            <Skeleton width="30%" height="1rem" />
            <Skeleton width="90%" height="0.85rem" />
            <Skeleton width="80%" height="0.85rem" />
          </div>
        </div>
      </AppShell>
    )
  }

  if (story.status === 'error' || !story.data) {
    return (
      <AppShell>
        <ErrorState
          title="We couldn't open that story"
          message={story.error}
          onRetry={story.reload}
        />
      </AppShell>
    )
  }

  const data = story.data
  const hue = data.genres[0]?.hue ?? 268

  /**
   * Falls back to what the story row already carries, so the header does not
   * flash a dash while the breakdown request is still out. The zeroed
   * breakdown is only ever drawn once `ratings` is ready.
   */
  const summary = ratings.data ?? {
    average: data.ratingAverage,
    count: data.ratingCount,
    breakdown: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    mine: null,
  }
  const authorName = storyAuthorName(data.author)

  // No reading-progress endpoint yet, so every reader starts at the first
  // chapter that exists rather than where they left off.
  const firstChapter = chapters.data?.[0]?.number ?? 1

  async function onSaveRating() {
    if (score < 1) {
      setRatingError('Pick a score between 1 and 5 stars.')
      return
    }

    setSavingRating(true)
    try {
      await engagement.rateStory(data.id, score)

      setRateOpen(false)
      setRatingError(null)
      showToast({ message: `Rated “${data.title}” ${score} out of 5.` })
      ratings.reload()
      // The story header carries the average too, and the API recomputed it
      // in the same transaction as the write.
      story.reload()
    } catch (cause) {
      setRatingError(
        cause instanceof Error ? cause.message : 'We could not save that rating.',
      )
    } finally {
      setSavingRating(false)
    }
  }

  async function onClearRating() {
    setSavingRating(true)
    try {
      await engagement.clearRating(data.id)

      setScore(0)
      setRateOpen(false)
      setRatingError(null)
      showToast({ message: 'Your rating was removed.' })
      ratings.reload()
      story.reload()
    } catch (cause) {
      setRatingError(
        cause instanceof Error ? cause.message : 'We could not remove that rating.',
      )
    } finally {
      setSavingRating(false)
    }
  }

  async function onPostComment(event: React.FormEvent) {
    event.preventDefault()

    const trimmed = commentBody.trim()
    if (trimmed.length === 0) {
      setCommentError('Write something before posting.')
      return
    }

    setPosting(true)
    try {
      await engagement.postComment(data.id, { content: trimmed })

      setCommentBody('')
      setCommentError(null)
      comments.reload()
    } catch (cause) {
      setCommentError(
        cause instanceof Error ? cause.message : 'We could not post that comment.',
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
      await engagement.postComment(data.id, {
        content: trimmed,
        parentId: threadId,
      })

      setReplyBody('')
      setReplyTo(null)
      // Open the thread so the new reply is visible where it landed.
      setOpenThreadId(threadId)
      replies.reload()
      comments.reload()
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

  async function onDeleteComment(comment: Comment) {
    try {
      await engagement.deleteComment(comment.id)
      showToast({ message: 'Comment deleted.' })
      comments.reload()
      replies.reload()
    } catch (cause) {
      showToast({
        tone: 'error',
        message:
          cause instanceof Error ? cause.message : 'We could not delete that.',
      })
    }
  }

  /** Opens the dialog on whatever the caller scored this before, if anything. */
  function openRateDialog() {
    setScore(ratings.data?.mine ?? 0)
    setRatingError(null)
    setRateOpen(true)
  }

  async function onShare() {
    const url = window.location.href
    try {
      if (navigator.share) {
        await navigator.share({ title: data.title, url })
        return
      }
      await navigator.clipboard.writeText(url)
      showToast({ message: 'Link copied to your clipboard.' })
    } catch {
      showToast({ tone: 'error', message: 'We could not share that link.' })
    }
  }

  function onToggleLibrary() {
    setInLibrary((current) => !current)
    showToast({
      message: inLibrary
        ? `Removed “${data.title}” from your library.`
        : `Saved “${data.title}” to your library.`,
    })
  }

  return (
    <AppShell>
      {/* Header --------------------------------------------------------- */}
      <header className="detail">
        <div className="detail__wash" style={{ background: coverWash(hue) }} aria-hidden="true" />

        <div className="detail__inner">
          <div className="detail__cover">
            <StoryCover story={data} size="xl" />
          </div>

          <div className="detail__body">
            <div className="detail__genres">
              {data.genres.map((genre) => (
                <GenreChip key={genre.id} genre={genre} asLink />
              ))}
              {data.status === 'completed' ? (
                <StatusBadge tone="success">
                  {STORY_STATUS_LABELS.completed}
                </StatusBadge>
              ) : data.status === 'draft' ? (
                <StatusBadge tone="warning">{STORY_STATUS_LABELS.draft}</StatusBadge>
              ) : (
                <StatusBadge tone="brand">{STORY_STATUS_LABELS.ongoing}</StatusBadge>
              )}
              {data.kidsAppropriate ? (
                <StatusBadge tone="neutral">Kid-friendly</StatusBadge>
              ) : null}
            </div>

            <h1 className="detail__title">{data.title}</h1>

            <Link className="detail__author" to={`/profile/${data.author.username}`}>
              <Avatar user={data.author} size="sm" />
              <span>
                by <strong>{authorName}</strong>
              </span>
            </Link>

            <div className="detail__rating">
              {/* From `summary`, not the story row, so a rating just saved is
                  reflected here without waiting for the story to reload. */}
              <Stars value={summary.average ?? 0} size="1.1rem" />
              <strong>
                {summary.average === null
                  ? 'Not rated yet'
                  : formatRating(summary.average)}
              </strong>
              {summary.count > 0 ? (
                <span>{formatCount(summary.count)} ratings</span>
              ) : null}
            </div>

            {data.description ? (
              <p className="detail__synopsis">{data.description}</p>
            ) : null}

            <dl className="detail__facts">
              <div>
                <dt>Reads</dt>
                <dd>{formatCount(data.viewCount)}</dd>
              </div>
              <div>
                <dt>Likes</dt>
                <dd>{formatCount(data.likeCount)}</dd>
              </div>
              <div>
                <dt>Chapters</dt>
                <dd>{data.chapterCount}</dd>
              </div>
              <div>
                <dt>Length</dt>
                <dd>{formatMinutes(readingMinutes(data.wordCount))}</dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{formatRelative(data.updatedAt)}</dd>
              </div>
            </dl>

            <div className="detail__actions">
              {/* A catalogue import has no chapters to open, and neither does
                  a story whose author has not published one yet. */}
              {data.chapterCount === 0 ? (
                <Button variant="primary" size="lg" disabled startIcon={<Icon name="book-open" />}>
                  No chapters yet
                </Button>
              ) : (
                <ButtonLink
                  variant="primary"
                  size="lg"
                  to={`/read/${data.slug}/${firstChapter}`}
                  startIcon={<Icon name="book-open" />}
                >
                  Read Now
                </ButtonLink>
              )}

              <Button
                size="lg"
                onClick={onToggleLibrary}
                startIcon={<Icon name={inLibrary ? 'bookmark-filled' : 'bookmark'} />}
              >
                {inLibrary ? 'In your library' : 'Add to Library'}
              </Button>

              <Button
                size="lg"
                onClick={openRateDialog}
                startIcon={<Icon name="star" />}
              >
                {ratings.data?.mine ? `Rated ${ratings.data.mine}` : 'Rate'}
              </Button>

              <Button
                size="lg"
                iconOnly
                aria-label="Share this story"
                onClick={onShare}
                startIcon={<Icon name="share" />}
              />
            </div>
          </div>
        </div>
      </header>

      {/* Tabs ----------------------------------------------------------- */}
      <div className="detail__tabs">
        <Tabs
          items={TABS.map((item) =>
            item.id === 'chapters'
              ? { ...item, count: data.chapterCount }
              : item.id === 'comments'
                ? // Threads, not threads plus replies: the list below shows
                  // threads, and a count it does not match reads as a bug.
                  { ...item, count: comments.data?.total ?? 0 }
                : { ...item, count: ratings.data?.count ?? data.ratingCount },
          )}
          active={tab}
          onChange={setTab}
          label="Story sections"
        />
      </div>

      {tab === 'chapters' ? (
        <TabPanel id="chapters">
          {chapters.status === 'ready' && chapters.data?.length === 0 ? (
            <EmptyState
              icon="book"
              size="sm"
              title="No chapters published yet"
              description="Check back — the author has not posted a first chapter."
            />
          ) : chapters.status === 'error' ? (
            <ErrorState message={chapters.error} onRetry={chapters.reload} />
          ) : chapters.status === 'loading' ? (
            <ul className="chapter-list">
              {Array.from({ length: 6 }, (_, index) => (
                <li key={index} className="chapter-row">
                  <Skeleton width="100%" height="1.5rem" />
                </li>
              ))}
            </ul>
          ) : (
            <ul className="chapter-list">
              {chapters.data?.map((chapter) => (
                <li key={chapter.id}>
                  <Link className="chapter-row" to={`/read/${data.slug}/${chapter.number}`}>
                    <span className="chapter-row__number">{chapter.number}</span>
                    <span className="chapter-row__text">
                      <span className="chapter-row__title">{chapter.title}</span>
                      {/* Attachments are deliberately absent: the chapter
                          list endpoint returns no bodies and no media, so a
                          count here would cost a request per row. */}
                      <span className="chapter-row__meta">
                        {chapter.publishedAt ? formatDate(chapter.publishedAt) : 'Unpublished'} ·{' '}
                        {readingMinutes(chapter.wordCount)} min read
                      </span>
                    </span>
                    <Icon name="chevron-right" size="1rem" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </TabPanel>
      ) : null}

      {tab === 'reviews' ? (
        <TabPanel id="reviews">
          <div className="reviews">
            <Card className="reviews__summary">
              {ratings.status === 'loading' ? (
                <Skeleton width="100%" height="12rem" />
              ) : ratings.status === 'error' ? (
                <ErrorState message={ratings.error} onRetry={ratings.reload} />
              ) : (
                <>
                  <p className="reviews__score">
                    {summary.average === null ? '—' : formatRating(summary.average)}
                  </p>
                  <Stars value={summary.average ?? 0} size="1.1rem" />
                  <p className="reviews__count">
                    {formatCount(summary.count)}{' '}
                    {summary.count === 1 ? 'rating' : 'ratings'}
                  </p>

                  {/* Counted from real `Rating` rows. The bars were unused
                      until this endpoint existed, precisely because drawing
                      them from invented weights would have been a lie. */}
                  <RatingBars breakdown={summary.breakdown} total={summary.count} />

                  <Button
                    fullWidth
                    onClick={openRateDialog}
                    startIcon={<Icon name="star" />}
                  >
                    {summary.mine ? 'Change your rating' : 'Rate this story'}
                  </Button>
                </>
              )}
            </Card>

            <div className="reviews__list">
              {/*
                A rating is a score and nothing else: `engagement.Rating` has
                no body column, so there is no written review to list. Adding
                one is a migration, not a UI change.
              */}
              <EmptyState
                icon="star"
                size="sm"
                title="Ratings only, for now"
                description="Scores are recorded without a written review — leave a comment to say more."
              />
            </div>
          </div>
        </TabPanel>
      ) : null}

      {tab === 'comments' ? (
        <TabPanel id="comments">
          <form className="comment-form" onSubmit={onPostComment}>
            <TextField
              multiline
              label="Add a comment"
              placeholder="Share what you thought — no spoilers past the latest chapter."
              rows={3}
              value={commentBody}
              error={commentError ?? undefined}
              maxLength={COMMENT_MAX_LENGTH}
              counterMax={COMMENT_MAX_LENGTH}
              disabled={posting}
              onChange={(event) => {
                setCommentBody(event.target.value)
                setCommentError(null)
              }}
            />
            <div className="comment-form__actions">
              <Button
                variant="primary"
                type="submit"
                loading={posting}
                startIcon={<Icon name="send" size="0.95em" />}
              >
                Post comment
              </Button>
            </div>
          </form>

          {comments.status === 'error' ? (
            <ErrorState message={comments.error} onRetry={comments.reload} />
          ) : comments.status === 'loading' ? (
            <div className="comment-list">
              {Array.from({ length: 3 }, (_, index) => (
                <Skeleton key={index} height="4.5rem" radius="var(--radius-md)" />
              ))}
            </div>
          ) : (comments.data?.items.length ?? 0) === 0 ? (
            <EmptyState
              icon="comment"
              size="sm"
              title="No comments yet"
              description="Be the first to say something about this story."
            />
          ) : (
            <ul className="comment-list">
              {comments.data?.items.map((comment) => {
                const open = openThreadId === comment.id

                return (
                  <li className="comment" key={comment.id}>
                    <Avatar user={comment.user} size="md" />
                    <div className="comment__body">
                      <p className="comment__head">
                        <strong>{commentUserName(comment.user)}</strong>
                        <span>{formatRelative(comment.createdAt)}</span>
                      </p>
                      <p className="comment__text">{comment.content}</p>

                      <p className="comment__actions">
                        <span>
                          <Icon name="comment" size="0.9em" />
                          {formatCount(comment.replyCount)}{' '}
                          {comment.replyCount === 1 ? 'reply' : 'replies'}
                        </span>
                        {comment.replyCount > 0 ? (
                          <button
                            type="button"
                            onClick={() =>
                              setOpenThreadId(open ? null : comment.id)
                            }
                          >
                            {open ? 'Hide replies' : 'Show replies'}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => {
                            setReplyTo(replyTo === comment.id ? null : comment.id)
                            setReplyBody('')
                          }}
                        >
                          Reply
                        </button>
                        {/*
                          Shown only to the one person the API would let
                          delete it. A story's author is not a moderator here
                          -- that role arrives with the moderation task.
                        */}
                        {comment.user.id === myId ? (
                          <button
                            type="button"
                            onClick={() => onDeleteComment(comment)}
                          >
                            Delete
                          </button>
                        ) : null}
                      </p>

                      {open ? (
                        replies.status === 'loading' ? (
                          <Skeleton height="4rem" radius="var(--radius-md)" />
                        ) : (
                          <ul className="comment-replies">
                            {replies.data?.items.map((reply) => (
                              <li key={reply.id}>
                                <Avatar user={reply.user} size="sm" />
                                <div>
                                  <p className="comment__head">
                                    <strong>{commentUserName(reply.user)}</strong>
                                    <span>{formatRelative(reply.createdAt)}</span>
                                  </p>
                                  <p className="comment__text">{reply.content}</p>
                                  {reply.user.id === myId ? (
                                    <p className="comment__actions">
                                      <button
                                        type="button"
                                        onClick={() => onDeleteComment(reply)}
                                      >
                                        Delete
                                      </button>
                                    </p>
                                  ) : null}
                                </div>
                              </li>
                            ))}
                          </ul>
                        )
                      ) : null}

                      {replyTo === comment.id ? (
                        <div className="comment__reply-form">
                          <TextField
                            multiline
                            hideLabel
                            label={`Reply to ${commentUserName(comment.user)}`}
                            placeholder="Write a reply…"
                            rows={3}
                            value={replyBody}
                            maxLength={COMMENT_MAX_LENGTH}
                            disabled={posting}
                            onChange={(event) => setReplyBody(event.target.value)}
                          />
                          <div className="comment__reply-actions">
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
                              onClick={() => onPostReply(comment.id)}
                            >
                              Reply
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
        </TabPanel>
      ) : null}

      {/* About the author ----------------------------------------------- */}
      <section className="page-section">
        <SectionHead title="About the author" />
        <Card className="author-panel">
          <Avatar user={data.author} size="xl" />
          <div className="author-panel__body">
            <h3>
              <Link to={`/profile/${data.author.username}`}>{authorName}</Link>
            </h3>
            <p className="author-panel__handle">@{data.author.username}</p>
            {/* Bio, follower count and join date come from the public profile
                endpoint, which does not exist yet -- and a Follow button needs
                a follow relationship, which the schema has no table for. */}
          </div>
          <div className="author-panel__actions">
            <ButtonLink to={`/profile/${data.author.username}`}>View profile</ButtonLink>
          </div>
        </Card>
      </section>

      {/* Similar -------------------------------------------------------- */}
      <section className="page-section">
        <SectionHead title="Readers also enjoyed" />
        {similar.status === 'error' ? (
          <ErrorState message={similar.error} onRetry={similar.reload} />
        ) : similar.status === 'loading' ? (
          <div className="story-grid">
            {Array.from({ length: 4 }, (_, index) => (
              <StoryCardSkeleton key={index} />
            ))}
          </div>
        ) : similar.data?.length === 0 ? (
          <EmptyState icon="book" size="sm" title="Nothing similar yet" />
        ) : (
          <div className="story-grid">
            {similar.data?.map((item) => (
              <StoryCard key={item.id} story={item} />
            ))}
          </div>
        )}
      </section>

      {/* Rating dialog -------------------------------------------------- */}
      <Dialog
        open={rateOpen}
        onClose={() => setRateOpen(false)}
        title={`Rate “${data.title}”`}
        description="Your rating helps other readers find it."
        dismissible={!savingRating}
        footer={
          <>
            {/* Only offered to somebody who has a rating to withdraw. */}
            {summary.mine ? (
              <Button onClick={onClearRating} disabled={savingRating}>
                Remove rating
              </Button>
            ) : null}
            <Button onClick={() => setRateOpen(false)} disabled={savingRating}>
              Cancel
            </Button>
            <Button variant="primary" loading={savingRating} onClick={onSaveRating}>
              Save rating
            </Button>
          </>
        }
      >
        <div className="rate-dialog">
          <RatingInput
            value={score}
            onChange={(next) => {
              setScore(next)
              setRatingError(null)
            }}
            label={`Your rating for ${data.title}`}
            disabled={savingRating}
          />
          {ratingError ? (
            <p className="rate-dialog__error" role="alert">
              {ratingError}
            </p>
          ) : null}
          {/*
            The written-review field that used to sit here has gone:
            `engagement.Rating` stores a score and nothing else, so every
            word typed into it was discarded on save. The comment form on the
            Comments tab is where a reader says more.
          */}
          <p className="rate-dialog__note">
            Ratings are public as an average — your individual score is not
            shown next to your name.
          </p>
        </div>
      </Dialog>
    </AppShell>
  )
}
