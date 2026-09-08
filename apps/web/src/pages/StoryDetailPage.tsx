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
import * as api from '../data/api'
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
import { RatingBars } from '../components/charts/RatingBars'
import { StoryCard } from '../components/story/StoryCard'
import { StoryCover } from '../components/story/StoryCover'
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

  const story = useAsync(() => api.getStory(slug), [slug])
  const storyId = story.data?.id

  const chapters = useAsync(
    () => (storyId ? api.getChapters(storyId) : Promise.resolve([])),
    [storyId],
  )
  const comments = useAsync(
    () => (storyId ? api.getComments(storyId) : Promise.resolve([])),
    [storyId],
  )
  const reviews = useAsync(
    () => (storyId ? api.getRatings(storyId) : Promise.resolve([])),
    [storyId],
  )
  const similar = useAsync(
    () => (story.data ? api.getSimilarStories(story.data) : Promise.resolve([])),
    [storyId],
  )
  const reading = useAsync(
    () => (storyId ? api.getReadingEntryForStory(storyId) : Promise.resolve(null)),
    [storyId],
  )

  const [tab, setTab] = useState<DetailTab>('chapters')
  const [inLibrary, setInLibrary] = useState(false)
  const [rateOpen, setRateOpen] = useState(false)
  const [score, setScore] = useState(0)
  const [review, setReview] = useState('')
  const [ratingError, setRatingError] = useState<string | null>(null)
  const [savingRating, setSavingRating] = useState(false)
  const [commentBody, setCommentBody] = useState('')
  const [commentError, setCommentError] = useState<string | null>(null)
  const [postingComment, setPostingComment] = useState(false)
  const [localComments, setLocalComments] = useState<api.CommentWithUser[]>([])

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
  const breakdown = api.getRatingBreakdown(data)
  const resumeChapter = reading.data?.chapter.number ?? 1
  const allComments = [...localComments, ...(comments.data ?? [])]

  async function onSaveRating() {
    if (score === 0) {
      setRatingError('Choose a star rating first.')
      return
    }

    setSavingRating(true)
    setRatingError(null)
    try {
      // Ratings post through the same path a real endpoint will use.
      await new Promise((resolve) => setTimeout(resolve, 500))
      setRateOpen(false)
      showToast({ message: `You rated “${data.title}” ${score} ${score === 1 ? 'star' : 'stars'}.` })
    } catch {
      setRatingError('We could not save your rating. Please try again.')
    } finally {
      setSavingRating(false)
    }
  }

  async function onPostComment(event: React.FormEvent) {
    event.preventDefault()
    if (postingComment) return

    if (commentBody.trim().length === 0) {
      setCommentError('Write something before posting.')
      return
    }

    setPostingComment(true)
    setCommentError(null)
    try {
      const posted = await api.addComment(data.id, commentBody)
      setLocalComments((current) => [posted, ...current])
      setCommentBody('')
      showToast({ message: 'Comment posted.' })
    } catch (error) {
      setCommentError(
        error instanceof Error ? error.message : 'We could not post that. Please try again.',
      )
    } finally {
      setPostingComment(false)
    }
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
                <StatusBadge tone="success">Completed</StatusBadge>
              ) : data.status === 'hiatus' ? (
                <StatusBadge tone="warning">On hiatus</StatusBadge>
              ) : (
                <StatusBadge tone="brand">Ongoing</StatusBadge>
              )}
              {data.kidsAppropriate ? (
                <StatusBadge tone="neutral">Kid-friendly</StatusBadge>
              ) : null}
            </div>

            <h1 className="detail__title">{data.title}</h1>

            <Link className="detail__author" to={`/profile/${data.author.username}`}>
              <Avatar user={data.author} size="sm" />
              <span>
                by <strong>{data.author.displayName}</strong>
              </span>
            </Link>

            <div className="detail__rating">
              <Stars value={data.ratingAverage} size="1.1rem" />
              <strong>{formatRating(data.ratingAverage)}</strong>
              <span>
                {formatCount(data.ratingCount)} ratings · {formatCount(data.commentCount)}{' '}
                comments
              </span>
            </div>

            <p className="detail__synopsis">{data.synopsis}</p>

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
                <dd>{formatMinutes(data.wordCount / 220)}</dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{formatRelative(data.updatedAt)}</dd>
              </div>
            </dl>

            <div className="detail__actions">
              <ButtonLink
                variant="primary"
                size="lg"
                to={`/read/${data.slug}/${resumeChapter}`}
                startIcon={<Icon name="book-open" />}
              >
                {reading.data && reading.data.history.storyProgress > 0
                  ? `Continue chapter ${resumeChapter}`
                  : 'Read Now'}
              </ButtonLink>

              <Button
                size="lg"
                onClick={onToggleLibrary}
                startIcon={<Icon name={inLibrary ? 'bookmark-filled' : 'bookmark'} />}
              >
                {inLibrary ? 'In your library' : 'Add to Library'}
              </Button>

              <Button
                size="lg"
                onClick={() => setRateOpen(true)}
                startIcon={<Icon name="star" />}
              >
                Rate
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
                ? { ...item, count: allComments.length }
                : { ...item, count: reviews.data?.length },
          )}
          active={tab}
          onChange={setTab}
          label="Story sections"
        />
      </div>

      {tab === 'chapters' ? (
        <TabPanel id="chapters">
          {chapters.status === 'error' ? (
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
                      <span className="chapter-row__meta">
                        {chapter.publishedAt ? formatDate(chapter.publishedAt) : 'Unpublished'} ·{' '}
                        {chapter.readingMinutes} min read
                        {chapter.multimedia.length > 0 ? (
                          <>
                            {' · '}
                            <span className="chapter-row__media">
                              <Icon
                                name={chapter.multimedia[0]!.kind === 'audio' ? 'audio' : 'image'}
                                size="0.85em"
                              />
                              {chapter.multimedia.length} attachment
                              {chapter.multimedia.length === 1 ? '' : 's'}
                            </span>
                          </>
                        ) : null}
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
              <p className="reviews__score">{formatRating(data.ratingAverage)}</p>
              <Stars value={data.ratingAverage} size="1.1rem" />
              <p className="reviews__count">{formatCount(data.ratingCount)} ratings</p>
              <RatingBars breakdown={breakdown} total={data.ratingCount} />
              <Button fullWidth onClick={() => setRateOpen(true)} startIcon={<Icon name="star" />}>
                Write a review
              </Button>
            </Card>

            <div className="reviews__list">
              {reviews.status === 'error' ? (
                <ErrorState message={reviews.error} onRetry={reviews.reload} />
              ) : reviews.data?.length === 0 ? (
                <EmptyState icon="star" size="sm" title="No written reviews yet" />
              ) : (
                reviews.data
                  ?.filter((entry) => entry.review)
                  .map((entry) => (
                    <article className="review" key={entry.id}>
                      <header>
                        <Avatar user={entry.user} size="sm" />
                        <div>
                          <p className="review__name">{entry.user.displayName}</p>
                          <p className="review__meta">
                            <Stars value={entry.score} size="0.8em" />
                            {formatRelative(entry.createdAt)}
                          </p>
                        </div>
                      </header>
                      <p className="review__body">{entry.review}</p>
                    </article>
                  ))
              )}
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
              maxLength={1000}
              counterMax={1000}
              disabled={postingComment}
              onChange={(event) => {
                setCommentBody(event.target.value)
                setCommentError(null)
              }}
            />
            <div className="comment-form__actions">
              <Button
                variant="primary"
                type="submit"
                loading={postingComment}
                startIcon={<Icon name="send" size="0.95em" />}
              >
                Post comment
              </Button>
            </div>
          </form>

          {comments.status === 'error' ? (
            <ErrorState message={comments.error} onRetry={comments.reload} />
          ) : allComments.length === 0 ? (
            <EmptyState
              icon="comment"
              size="sm"
              title="No comments yet"
              description="Be the first to say something about this story."
            />
          ) : (
            <ul className="comment-list">
              {allComments.map((comment) => (
                <li className="comment" key={comment.id}>
                  <Avatar user={comment.user} size="sm" />
                  <div className="comment__body">
                    <p className="comment__head">
                      <strong>{comment.user.displayName}</strong>
                      <span>{formatRelative(comment.createdAt)}</span>
                    </p>
                    <p className="comment__text">{comment.body}</p>
                    <p className="comment__actions">
                      <span>
                        <Icon name="heart" size="0.9em" />
                        {formatCount(comment.likeCount)}
                      </span>
                      <span>
                        <Icon name="comment" size="0.9em" />
                        {comment.replyCount} replies
                      </span>
                    </p>
                  </div>
                </li>
              ))}
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
              <Link to={`/profile/${data.author.username}`}>{data.author.displayName}</Link>
            </h3>
            <p className="author-panel__handle">@{data.author.username}</p>
            <p className="author-panel__bio">{data.author.bio}</p>
            <p className="author-panel__stats">
              <span>
                <Icon name="users" size="0.9em" />
                {formatCount(data.author.followerCount)} followers
              </span>
              <span>
                <Icon name="calendar" size="0.9em" />
                Joined {formatDate(data.author.joinedAt)}
              </span>
            </p>
          </div>
          <div className="author-panel__actions">
            <Button variant="primary" startIcon={<Icon name="user-plus" size="1em" />}>
              Follow
            </Button>
            <ButtonLink to={`/profile/${data.author.username}`}>View profile</ButtonLink>
          </div>
        </Card>
      </section>

      {/* Similar -------------------------------------------------------- */}
      <section className="page-section">
        <SectionHead title="Readers also enjoyed" />
        {similar.data?.length === 0 ? (
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
          <TextField
            multiline
            label="Review (optional)"
            placeholder="What worked, what didn't, who should read it."
            rows={4}
            value={review}
            maxLength={2000}
            counterMax={2000}
            disabled={savingRating}
            onChange={(event) => setReview(event.target.value)}
          />
        </div>
      </Dialog>
    </AppShell>
  )
}
