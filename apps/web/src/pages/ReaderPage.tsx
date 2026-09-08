import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAsync } from '../hooks/useAsync'
import { cn } from '../lib/cn'
import { useToast } from '../lib/toast'
import {
  FONT_SIZES,
  FONT_SIZE_LABELS,
  READING_THEMES,
  READING_THEME_LABELS,
  READING_WIDTHS,
  READING_WIDTH_LABELS,
  useReaderPrefs,
} from '../lib/reader-prefs'
import { formatCount, formatDuration, formatRelative } from '../lib/format'
import { coverArt } from '../lib/cover'
import * as api from '../data/api'
import { Avatar } from '../components/ui/Avatar'
import { Button, ButtonLink } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { SegmentedControl } from '../components/ui/Tabs'
import { Select } from '../components/ui/Select'
import { Skeleton } from '../components/ui/Skeleton'
import { Switch } from '../components/ui/Checkbox'
import { ErrorState } from '../components/ui/States'
import { Dialog } from '../components/ui/Dialog'
import type { Multimedia } from '../types/domain'
import './reader.css'

/** Media attached to a chapter. Rendered as styled placeholders for now. */
function ChapterMedia({ item, hue }: { item: Multimedia; hue: number }) {
  const art = coverArt(item.id, hue)

  if (item.kind === 'audio') {
    return (
      <figure className="media media--audio">
        <div className="media__player">
          <span className="media__play">
            <Icon name="play" size="1.1rem" />
          </span>
          <span className="media__track">
            <span className="media__bar" />
          </span>
          <span className="media__time">
            {formatDuration(item.durationSeconds ?? 0)}
          </span>
        </div>
        <figcaption>
          <Icon name="audio" size="0.9em" />
          {item.caption}
        </figcaption>
      </figure>
    )
  }

  return (
    <figure className={cn('media', `media--${item.kind}`)}>
      <div className="media__plate" style={{ background: art.background }}>
        {item.kind === 'video' ? (
          <span className="media__play media__play--overlay">
            <Icon name="play" size="1.3rem" />
          </span>
        ) : null}
      </div>
      <figcaption>
        <Icon name={item.kind === 'video' ? 'video' : 'image'} size="0.9em" />
        {item.caption}
      </figcaption>
    </figure>
  )
}

export function ReaderPage() {
  const { slug = '', chapter: chapterParam = '1' } = useParams()
  const chapterNumber = Number(chapterParam) || 1
  const navigate = useNavigate()
  const { showToast } = useToast()
  const { preferences, update } = useReaderPrefs()

  const story = useAsync(() => api.getStory(slug), [slug])
  const storyId = story.data?.id

  const chapters = useAsync(
    () => (storyId ? api.getChapters(storyId) : Promise.resolve([])),
    [storyId],
  )
  const chapter = useAsync(
    () => (storyId ? api.getChapter(storyId, chapterNumber) : Promise.resolve(null)),
    [storyId, chapterNumber],
  )
  const comments = useAsync(
    () => (storyId ? api.getComments(storyId) : Promise.resolve([])),
    [storyId],
  )

  const [progress, setProgress] = useState(0)
  const [focusMode, setFocusMode] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [bookmarked, setBookmarked] = useState(false)
  const [showComments, setShowComments] = useState(false)

  const total = chapters.data?.length ?? 0
  const hasPrev = chapterNumber > 1
  const hasNext = chapterNumber < total

  const goToChapter = useCallback(
    (next: number) => {
      if (next < 1 || (total > 0 && next > total)) return
      navigate(`/read/${slug}/${next}`)
      window.scrollTo({ top: 0 })
    },
    [navigate, slug, total],
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

      if (event.key === 'ArrowRight') goToChapter(chapterNumber + 1)
      else if (event.key === 'ArrowLeft') goToChapter(chapterNumber - 1)
      else if (event.key.toLowerCase() === 'f') setFocusMode((current) => !current)
      else if (event.key === 'Escape') setFocusMode(false)
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [chapterNumber, goToChapter])

  if (story.status === 'error' || chapter.status === 'error') {
    return (
      <div className="reader" data-reading-theme={preferences.theme}>
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
      data-reading-theme={preferences.theme}
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
              Chapter {current.number} of {total} · {current.readingMinutes} min read
            </p>
            <h1 className="reader__title">{current.title}</h1>
            <p className="reader__byline">
              {data?.author.displayName}
              {current.publishedAt ? ` · ${formatRelative(current.publishedAt)}` : ''}
            </p>

            <div className="reader__prose">
              {current.paragraphs.map((paragraph, index) => (
                <p key={index}>{paragraph}</p>
              ))}

              {current.multimedia.map((item) => (
                <ChapterMedia key={item.id} item={item} hue={hue} />
              ))}
            </div>

            {/* Chapter footer ------------------------------------------- */}
            <footer className="reader__footer">
              <div className="reader__reactions">
                <Button startIcon={<Icon name="heart" size="1em" />}>
                  {formatCount(current.viewCount / 12)}
                </Button>
                <Button
                  onClick={() => setShowComments((open) => !open)}
                  startIcon={<Icon name="comment" size="1em" />}
                >
                  {comments.data?.length ?? 0} comments
                </Button>
              </div>

              <nav className="reader__pager" aria-label="Chapter navigation">
                <Button
                  disabled={!hasPrev}
                  onClick={() => goToChapter(chapterNumber - 1)}
                  startIcon={<Icon name="chevron-left" size="1em" />}
                >
                  Previous
                </Button>

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

                <Button
                  variant="primary"
                  disabled={!hasNext}
                  onClick={() => goToChapter(chapterNumber + 1)}
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
                <h2>Comments</h2>
                {comments.data?.length === 0 ? (
                  <p className="reader__no-comments">No comments on this story yet.</p>
                ) : (
                  <ul>
                    {comments.data?.slice(0, 5).map((comment) => (
                      <li key={comment.id}>
                        <Avatar user={comment.user} size="sm" />
                        <div>
                          <p className="reader__comment-head">
                            <strong>{comment.user.displayName}</strong>
                            <span>{formatRelative(comment.createdAt)}</span>
                          </p>
                          <p>{comment.body}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
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
