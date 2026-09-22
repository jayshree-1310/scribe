import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAsync } from '../hooks/useAsync'
import { useReadingProgress } from '../hooks/useReadingProgress'
import { cn } from '../lib/cn'
import { useToast } from '../lib/toast'
import {
  FONT_SIZES,
  FONT_SIZE_LABELS,
  READING_THEMES,
  READING_THEME_LABELS,
  READING_WIDTHS,
  READING_WIDTH_LABELS,
  resolveReadingTheme,
  useReaderPrefs,
} from '../lib/reader-prefs'
import { useTheme } from '../lib/theme'
import { formatCount, formatRelative } from '../lib/format'
import { renderChapter } from '../lib/chapter-markdown'
import * as stories from '../data/stories-api'
import * as engagement from '../data/engagement-api'
import { readingMinutes, storyAuthorName } from '../types/stories'
import {
  COMMENT_MAX_LENGTH,
  commentUserName,
} from '../types/engagement'
import { LikeButton } from '../components/engagement/LikeButton'
import { Button, ButtonLink } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { Avatar } from '../components/ui/Avatar'
import { TextField } from '../components/ui/TextField'
import { EmptyState } from '../components/ui/States'
import { SegmentedControl } from '../components/ui/Tabs'
import { Select } from '../components/ui/Select'
import { Skeleton } from '../components/ui/Skeleton'
import { Switch } from '../components/ui/Checkbox'
import { ErrorState } from '../components/ui/States'
import { Dialog } from '../components/ui/Dialog'
import './reader.css'

export function ReaderPage() {
  const { slug = '', chapter: chapterParam = '1' } = useParams()
  const chapterNumber = Number(chapterParam) || 1
  const navigate = useNavigate()
  const { showToast } = useToast()
  const { preferences, update } = useReaderPrefs()
  const { resolved: appTheme } = useTheme()

  /**
   * The surface to draw. `preferences.theme` may be `auto`, which is a
   * preference rather than a surface — see `resolveReadingTheme`. Resolved
   * once here so the error page and the article below cannot disagree.
   */
  const surface = resolveReadingTheme(preferences.theme, appTheme)

  const story = useAsync(() => stories.getStory(slug), [slug])
  const storyId = story.data?.id

  const chapters = useAsync(
    () => (storyId ? stories.getChapters(storyId) : Promise.resolve([])),
    [storyId],
  )
  const chapter = useAsync(
    () =>
      storyId ? stories.getChapter(storyId, chapterNumber) : Promise.resolve(null),
    [storyId, chapterNumber],
  )


  const [progress, setProgress] = useState(0)

  /**
   * Restores the reader's place when a chapter opens and saves it as they
   * scroll, off the same `progress` fraction the bar above is drawn from.
   */
  useReadingProgress({
    storyId,
    chapter: chapter.data ?? null,
    scrollFraction: progress,
  })

  const [focusMode, setFocusMode] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [bookmarked, setBookmarked] = useState(false)
  const [showComments, setShowComments] = useState(false)

  const chapterId = chapter.data?.id

  /**
   * Scoped to this chapter rather than the whole story: the panel sits inside
   * a chapter, and a reader on chapter two should not be shown chapter nine's
   * spoilers. The story page's Comments tab is the unscoped view.
   *
   * Only requested once the panel is open, so a reader who never opens it
   * pays nothing for it.
   */
  const comments = useAsync(
    () =>
      storyId && chapterId && showComments
        ? engagement.listComments(storyId, { chapterId, limit: 20 })
        : Promise.resolve(null),
    [storyId, chapterId, showComments],
  )

  const [commentBody, setCommentBody] = useState('')
  const [commentError, setCommentError] = useState<string | undefined>()
  const [posting, setPosting] = useState(false)

  const postComment = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault()
      if (!storyId || !chapterId) return

      const trimmed = commentBody.trim()
      if (trimmed.length === 0) {
        setCommentError('Write something before posting.')
        return
      }

      setPosting(true)
      try {
        await engagement.postComment(storyId, { content: trimmed, chapterId })

        setCommentBody('')
        setCommentError(undefined)
        comments.reload()
      } catch (cause) {
        setCommentError(
          cause instanceof Error
            ? cause.message
            : 'We could not post that comment.',
        )
      } finally {
        setPosting(false)
      }
    },
    [storyId, chapterId, commentBody, comments],
  )

  /**
   * Null until the panel has been opened once: the list is only requested
   * when it is on screen, so before that there is no count to show and the
   * button says "Comments" rather than a confident nothing.
   */
  const commentTotal = comments.data?.total ?? null

  const total = chapters.data?.length ?? 0
  /**
   * Chapter numbers need not be contiguous — an unpublished chapter in the
   * middle is invisible to a reader — so the neighbours come from the API
   * rather than from `chapterNumber ± 1`.
   */
  const previousNumber = chapter.data?.previousNumber ?? null
  const nextNumber = chapter.data?.nextNumber ?? null

  const goToChapter = useCallback(
    (next: number | null) => {
      if (next === null) return
      navigate(`/read/${slug}/${next}`)
      window.scrollTo({ top: 0 })
    },
    [navigate, slug],
  )

  // Scroll-linked reading progress.
  useEffect(() => {
    let frame = 0
    function onScroll() {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const scrollable = document.body.scrollHeight - window.innerHeight
        setProgress(scrollable <= 0 ? 1 : Math.min(1, window.scrollY / scrollable))
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onScroll)
    }
  }, [chapterNumber])

  // Keyboard navigation: arrows move chapters, F toggles focus mode.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return

      if (event.key === 'ArrowRight') goToChapter(nextNumber)
      else if (event.key === 'ArrowLeft') goToChapter(previousNumber)
      else if (event.key.toLowerCase() === 'f') setFocusMode((current) => !current)
      else if (event.key === 'Escape') setFocusMode(false)
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [goToChapter, nextNumber, previousNumber])

  if (story.status === 'error' || chapter.status === 'error') {
    return (
      <div className="reader" data-reading-theme={surface}>
        <div className="reader__error">
          <ErrorState
            title="We couldn't open that chapter"
            message={story.error ?? chapter.error}
            onRetry={() => {
              story.reload()
              chapter.reload()
            }}
          />
          <ButtonLink to={`/story/${slug}`}>Back to the story</ButtonLink>
        </div>
      </div>
    )
  }

  const data = story.data
  const current = chapter.data
  const hue = data?.genres[0]?.hue ?? 268

  return (
    <div
      className={cn('reader', focusMode && 'is-focus')}
      data-reading-theme={surface}
      data-font-size={preferences.fontSize}
      data-width={preferences.width}
    >
      {/* Reading progress ---------------------------------------------- */}
      <div
        className="reader__progress"
        role="progressbar"
        aria-label="Reading progress in this chapter"
        aria-valuenow={Math.round(progress * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span style={{ transform: `scaleX(${progress})` }} />
      </div>

      {/* Top bar -------------------------------------------------------- */}
      <header className="reader__bar">
        <Link className="reader__back" to={`/story/${slug}`}>
          <Icon name="chevron-left" size="1.1rem" />
          <span className="reader__back-text">
            {data?.title ?? 'Back'}
          </span>
        </Link>

        <div className="reader__bar-actions">
          <Button
            variant="ghost"
            iconOnly
            aria-label={bookmarked ? 'Remove bookmark' : 'Bookmark this chapter'}
            aria-pressed={bookmarked}
            className={cn('reader__bookmark', bookmarked && 'is-on')}
            onClick={() => {
              setBookmarked((current) => !current)
              showToast({
                message: bookmarked ? 'Bookmark removed.' : 'Bookmarked — find it in your library.',
              })
            }}
            startIcon={<Icon name={bookmarked ? 'bookmark-filled' : 'bookmark'} size="1.1rem" />}
          />

          <Button
            variant="ghost"
            iconOnly
            aria-label="Reading settings"
            onClick={() => setSettingsOpen(true)}
            startIcon={<Icon name="text-size" size="1.1rem" />}
          />

          <Button
            variant="ghost"
            iconOnly
            aria-label={focusMode ? 'Exit distraction-free mode' : 'Distraction-free mode'}
            aria-pressed={focusMode}
            onClick={() => setFocusMode((current) => !current)}
            startIcon={<Icon name="maximize" size="1.1rem" />}
          />
        </div>
      </header>

      {/* Chapter -------------------------------------------------------- */}
      <main className="reader__main" id="main">
        {chapter.status === 'loading' || !current ? (
          <div className="reader__article">
            <Skeleton width="40%" height="1rem" />
            <Skeleton width="80%" height="2rem" />
            {Array.from({ length: 10 }, (_, index) => (
              <Skeleton key={index} width={index % 3 === 2 ? '70%' : '100%'} height="0.9rem" />
            ))}
          </div>
        ) : (
          <article className="reader__article">
            <p className="reader__eyebrow">
              Chapter {current.number}
              {total > 0 ? ` of ${total}` : ''} ·{' '}
              {readingMinutes(current.wordCount)} min read
            </p>
            <h1 className="reader__title">{current.title}</h1>
            <p className="reader__byline">
              {data ? storyAuthorName(data.author) : ''}
              {current.publishedAt ? ` · ${formatRelative(current.publishedAt)}` : ''}
            </p>

            {/*
              Prose and attachments interleaved, in the order the chapter's
              own text puts them: an attachment sits where the author placed
              it, and one they never placed follows the text. See
              `lib/chapter-media.ts`.

              Through the same renderer as the editor's preview, so the
              headings and emphasis an author formats with are the ones their
              readers get. See `lib/chapter-markdown.tsx`.
            */}
            <div className="reader__prose">
              {renderChapter(current.content, current.multimedia, hue)}
            </div>

            {/* Chapter footer ------------------------------------------- */}
            <footer className="reader__footer">
              <div className="reader__reactions">
                {/*
                  A like on the chapter just read, not on the story: the button
                  is at the end of one chapter, and that is what "I liked this"
                  said here is about. See `engagement.ChapterLike` in the
                  contract.
                */}
                <LikeButton
                  subject="chapter"
                  subjectId={current.id}
                  likeCount={current.likeCount}
                  likedByMe={current.likedByMe}
                  variant="pill"
                  noun="this chapter"
                />

                <button
                  type="button"
                  className={cn(
                    'reader__toggle',
                    showComments && 'is-open',
                  )}
                  aria-expanded={showComments}
                  onClick={() => setShowComments((open) => !open)}
                >
                  <Icon name="comment" size="1em" />
                  <span>
                    {commentTotal === null
                      ? 'Comments'
                      : commentTotal === 1
                        ? '1 comment'
                        : `${formatCount(commentTotal)} comments`}
                  </span>
                </button>
              </div>

              <nav className="reader__pager" aria-label="Chapter navigation">
                <Button
                  disabled={previousNumber === null}
                  onClick={() => goToChapter(previousNumber)}
                  startIcon={<Icon name="chevron-left" size="1em" />}
                >
                  Previous
                </Button>

                {/*
                  Only once the list has actually arrived. An empty `options`
                  is indistinguishable from "this story has one chapter", so a
                  failed or in-flight request used to leave a picker that
                  silently offered nowhere to go. Previous and Next come from
                  the chapter itself and keep working either way, so omitting
                  this is a degradation rather than a dead end.
                */}
                {chapters.status === 'ready' && (chapters.data?.length ?? 0) > 1 ? (
                  <Select
                    label="Jump to chapter"
                    hideLabel
                    size="sm"
                    value={String(chapterNumber)}
                    options={(chapters.data ?? []).map((item) => ({
                      value: String(item.number),
                      label: `${item.number}. ${item.title}`,
                    }))}
                    onChange={(value) => goToChapter(Number(value))}
                  />
                ) : null}

                <Button
                  variant="primary"
                  disabled={nextNumber === null}
                  onClick={() => goToChapter(nextNumber)}
                  endIcon={<Icon name="chevron-right" size="1em" />}
                >
                  Next chapter
                </Button>
              </nav>

              <p className="reader__hint">
                Tip: use ← and → to move between chapters, and F for
                distraction-free reading.
              </p>
            </footer>

            {/* Comments ------------------------------------------------- */}
            {showComments ? (
              <section className="reader__comments" aria-label="Chapter comments">
                <header className="reader__comments-head">
                  <h2>Comments on this chapter</h2>
                  <p>Only what readers have said about chapter {current.number}.</p>
                </header>

                <form className="reader__comment-form" onSubmit={postComment}>
                  <TextField
                    multiline
                    hideLabel
                    label="Add a comment on this chapter"
                    placeholder="Share what you thought — no spoilers past this chapter."
                    rows={3}
                    value={commentBody}
                    error={commentError}
                    maxLength={COMMENT_MAX_LENGTH}
                    disabled={posting}
                    onChange={(event) => {
                      setCommentBody(event.target.value)
                      setCommentError(undefined)
                    }}
                  />
                  <div className="reader__comment-actions">
                    <Button
                      variant="primary"
                      size="sm"
                      type="submit"
                      loading={posting}
                      startIcon={<Icon name="send" size="0.95em" />}
                    >
                      Post comment
                    </Button>
                  </div>
                </form>

                {comments.status === 'error' ? (
                  <p className="reader__no-comments">{comments.error}</p>
                ) : comments.status === 'loading' ? (
                  <Skeleton height="5rem" radius="var(--radius-md)" />
                ) : (comments.data?.items.length ?? 0) === 0 ? (
                  <EmptyState
                    icon="comment"
                    size="sm"
                    title="No comments on this chapter yet"
                    description="Be the first to say something."
                  />
                ) : (
                  <ul className="reader__comment-list">
                    {comments.data?.items.map((comment) => (
                      <li key={comment.id}>
                        <Avatar user={comment.user} size="sm" />
                        <div className="reader__comment-body">
                          <p className="reader__comment-head">
                            <strong>{commentUserName(comment.user)}</strong>
                            <span>{formatRelative(comment.createdAt)}</span>
                          </p>
                          <p className="reader__comment-text">
                            {comment.content}
                          </p>

                          <div className="reader__comment-actions-row">
                            <LikeButton
                              subject="comment"
                              subjectId={comment.id}
                              likeCount={comment.likeCount}
                              likedByMe={comment.likedByMe}
                              noun="this comment"
                            />
                            {/*
                              The reply count is shown and not acted on: the
                              panel stays flat, and the link below is where a
                              conversation is had. A count with no way to open
                              it still tells a reader there is more there.
                            */}
                            {comment.replyCount > 0 ? (
                              <span className="reader__comment-replies">
                                <Icon name="comment" size="0.9em" />
                                {comment.replyCount}{' '}
                                {comment.replyCount === 1 ? 'reply' : 'replies'}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                {/*
                  Replies live on the story page. The panel deliberately stays
                  a flat, chapter-scoped list: a thread expanded mid-chapter
                  pushes the text the reader is in the middle of off-screen.
                */}
                <ButtonLink to={`/story/${slug}`} variant="ghost">
                  See all comments on the story page
                </ButtonLink>
              </section>
            ) : null}
          </article>
        )}
      </main>

      {/* Settings ------------------------------------------------------- */}
      <Dialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Reading settings"
        description="These apply everywhere you read on Scribe."
        size="sm"
      >
        <div className="reader-settings">
          <div className="reader-settings__group">
            <p className="reader-settings__label">Theme</p>
            <SegmentedControl
              label="Reading theme"
              value={preferences.theme}
              onChange={(theme) => update({ theme })}
              items={READING_THEMES.map((theme) => ({
                value: theme,
                label: READING_THEME_LABELS[theme],
              }))}
            />
          </div>

          <div className="reader-settings__group">
            <p className="reader-settings__label">Font size</p>
            <SegmentedControl
              label="Font size"
              value={preferences.fontSize}
              onChange={(fontSize) => update({ fontSize })}
              items={FONT_SIZES.map((size) => ({
                value: size,
                label: FONT_SIZE_LABELS[size],
              }))}
            />
          </div>

          <div className="reader-settings__group">
            <p className="reader-settings__label">Reading width</p>
            <SegmentedControl
              label="Reading width"
              value={preferences.width}
              onChange={(width) => update({ width })}
              items={READING_WIDTHS.map((width) => ({
                value: width,
                label: READING_WIDTH_LABELS[width],
              }))}
            />
          </div>

          <Switch
            checked={preferences.autoplayMultimedia}
            onChange={(autoplayMultimedia) => update({ autoplayMultimedia })}
            label="Autoplay chapter audio and video"
            description="Off by default so a chapter never makes noise unexpectedly."
          />
        </div>
      </Dialog>
    </div>
  )
}
