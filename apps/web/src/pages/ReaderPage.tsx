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
import { formatCount, formatRelative } from '../lib/format'
import { chapterBlocks } from '../lib/chapter-media'
import * as stories from '../data/stories-api'
import { readingMinutes, storyAuthorName } from '../types/stories'
import { Button, ButtonLink } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { SegmentedControl } from '../components/ui/Tabs'
import { Select } from '../components/ui/Select'
import { Skeleton } from '../components/ui/Skeleton'
import { Switch } from '../components/ui/Checkbox'
import { ErrorState } from '../components/ui/States'
import { Dialog } from '../components/ui/Dialog'
import { ChapterAttachment } from '../components/story/ChapterAttachment'
import './reader.css'

export function ReaderPage() {
  const { slug = '', chapter: chapterParam = '1' } = useParams()
  const chapterNumber = Number(chapterParam) || 1
  const navigate = useNavigate()
  const { showToast } = useToast()
  const { preferences, update } = useReaderPrefs()

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
  const [focusMode, setFocusMode] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [bookmarked, setBookmarked] = useState(false)
  const [showComments, setShowComments] = useState(false)

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
            */}
            <div className="reader__prose">
              {chapterBlocks(current.content, current.multimedia).map((block) =>
                block.kind === 'media' ? (
                  <ChapterAttachment key={block.key} item={block.item} hue={hue} />
                ) : (
                  <p key={block.key}>{block.text}</p>
                ),
              )}
            </div>

            {/* Chapter footer ------------------------------------------- */}
            <footer className="reader__footer">
              <div className="reader__reactions">
                {/* Likes are a story-level counter today; there is no
                    per-chapter reaction to show or to post. */}
                <Button startIcon={<Icon name="heart" size="1em" />}>
                  {formatCount(data?.likeCount ?? 0)}
                </Button>
                <Button
                  onClick={() => setShowComments((open) => !open)}
                  startIcon={<Icon name="comment" size="1em" />}
                >
                  Comments
                </Button>
              </div>

              <nav className="reader__pager" aria-label="Chapter navigation">
                <Button
                  disabled={previousNumber === null}
                  onClick={() => goToChapter(previousNumber)}
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
                <h2>Comments</h2>
                {/* No comments endpoint yet; the panel keeps its place so the
                    reader's layout does not shift when one arrives. */}
                <p className="reader__no-comments">
                  Comments are not available yet.
                </p>
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
