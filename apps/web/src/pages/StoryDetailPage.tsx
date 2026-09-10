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
import {
  STORY_STATUS_LABELS,
  readingMinutes,
  storyAuthorName,
} from '../types/stories'
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
   * Comments and written reviews have no endpoints yet, so both tabs show an
   * empty state and the two forms below report that rather than pretending to
   * save. The rating *counts* in the header are real.
   */
  const [tab, setTab] = useState<DetailTab>('chapters')
  const [inLibrary, setInLibrary] = useState(false)
  const [rateOpen, setRateOpen] = useState(false)
  const [score, setScore] = useState(0)
  const [review, setReview] = useState('')
  const [ratingError, setRatingError] = useState<string | null>(null)
  const [savingRating] = useState(false)
  const [commentBody, setCommentBody] = useState('')
  const [commentError, setCommentError] = useState<string | null>(null)

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
  const authorName = storyAuthorName(data.author)

  // No reading-progress endpoint yet, so every reader starts at the first
  // chapter that exists rather than where they left off.
  const firstChapter = chapters.data?.[0]?.number ?? 1

  function onSaveRating() {
    setRatingError('Ratings cannot be saved yet — there is no endpoint behind this form.')
  }

  function onPostComment(event: React.FormEvent) {
    event.preventDefault()
    setCommentError('Comments cannot be posted yet — there is no endpoint behind this form.')
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
              <Stars value={data.ratingAverage ?? 0} size="1.1rem" />
              <strong>
                {data.ratingAverage === null
                  ? 'Not rated yet'
                  : formatRating(data.ratingAverage)}
              </strong>
              {data.ratingCount > 0 ? (
                <span>{formatCount(data.ratingCount)} ratings</span>
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
                ? { ...item, count: 0 }
                : { ...item, count: data.ratingCount },
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
              <p className="reviews__score">
                {data.ratingAverage === null ? '—' : formatRating(data.ratingAverage)}
              </p>
              <Stars value={data.ratingAverage ?? 0} size="1.1rem" />
              <p className="reviews__count">
                {formatCount(data.ratingCount)}{' '}
                {data.ratingCount === 1 ? 'rating' : 'ratings'}
              </p>
              {/* The score distribution bars used to be fabricated from
                  hardcoded weights. Rendering them against a real rating count
                  would be a lie, so they wait for a real breakdown endpoint. */}
              <Button fullWidth onClick={() => setRateOpen(true)} startIcon={<Icon name="star" />}>
                Write a review
              </Button>
            </Card>

            <div className="reviews__list">
              <EmptyState
                icon="star"
                size="sm"
                title="No written reviews yet"
                description="Reviews arrive with the ratings endpoint."
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
              maxLength={1000}
              counterMax={1000}
              onChange={(event) => {
                setCommentBody(event.target.value)
                setCommentError(null)
              }}
            />
            <div className="comment-form__actions">
              <Button
                variant="primary"
                type="submit"
                startIcon={<Icon name="send" size="0.95em" />}
              >
                Post comment
              </Button>
            </div>
          </form>

          <EmptyState
            icon="comment"
            size="sm"
            title="No comments yet"
            description="Commenting arrives with the comments endpoint."
          />
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
