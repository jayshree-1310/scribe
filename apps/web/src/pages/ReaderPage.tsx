import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
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
import { useAuth } from '../lib/auth'
import { formatCount, formatRelative } from '../lib/format'
import { renderChapter } from '../lib/chapter-markdown'
import { findPassage } from '../lib/find-passage'
import * as stories from '../data/stories-api'
import * as engagement from '../data/engagement-api'
import { readingMinutes, storyAuthorName } from '../types/stories'
import {
  COMMENT_MAX_LENGTH,
  commentUserName,
} from '../types/engagement'
import { LikeButton } from '../components/engagement/LikeButton'
import { SignInPrompt } from '../components/engagement/SignInPrompt'
import { ReportMenu } from '../components/moderation/ReportMenu'
import { RecapCard } from '../components/ai/RecapCard'
import { ExplainSheet } from '../components/ai/ExplainSheet'
import { AskBookSheet } from '../components/ai/AskBookSheet'
import { readSelection, type ChapterSelection } from '../lib/chapter-selection'
import {
  indexText,
  paintHighlights,
  rangeContainsPoint,
  rangeForQuote,
} from '../lib/highlight-ranges'
import * as highlightsApi from '../data/highlights-api'
import type { SavedHighlight } from '../types/highlights'
import { HighlightNoteSheet } from '../components/reader/HighlightNoteSheet'
import { HighlightsSheet } from '../components/reader/HighlightsSheet'
import { BetaFeedbackSheet } from '../components/reader/BetaFeedbackSheet'
import { ListenBar } from '../components/reader/ListenBar'
import { useNarration } from '../hooks/useNarration'
import { LISTEN_RATES, firstVisibleBlock, narrationBlocks } from '../lib/narration'
import { prefersReducedMotion } from '../lib/motion'
import '../components/reader/beta.css'
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

/** How long a cited passage stays marked: long enough to find, then out of the way. */
const CITED_HIGHLIGHT_MS = 4000

/** The pause between the end of one chapter's narration and the next one's. */
const LISTEN_NEXT_CHAPTER_MS = 1200

/**
 * The part of the window the reader can actually see prose in: below the top
 * bar (which slides away in focus mode) and above the listen bar.
 */
function readingViewport(): { top: number; bottom: number } {
  const bar = document.querySelector('.reader__bar')?.getBoundingClientRect()
  const player = document.querySelector('.listen-bar')?.getBoundingClientRect()
  return {
    top: Math.max(0, bar?.bottom ?? 0),
    bottom: player ? player.top : window.innerHeight,
  }
}

function inReadingViewport(element: HTMLElement): boolean {
  const { top, bottom } = readingViewport()
  const rect = element.getBoundingClientRect()
  return rect.bottom > top && rect.top < bottom
}

export function ReaderPage() {
  const { slug = '', chapter: chapterParam = '1' } = useParams()
  const chapterNumber = Number(chapterParam) || 1
  const navigate = useNavigate()
  const { showToast } = useToast()
  const { preferences, update } = useReaderPrefs()
  const { resolved: appTheme } = useTheme()
  const { session } = useAuth()
  /**
   * Signed-out visitors can read a shared chapter. What needs an account --
   * bookmarks, likes, comments and the AI tools, every one of which answers to
   * a signed-in caller -- is hidden, or shown without the action.
   */
  const signedIn = session !== null

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


  /**
   * A beta reader: somebody the author invited to read unpublished chapters
   * (`StoryAccess`). On anything not yet public they get a feedback channel
   * to the author instead of the public one -- comments, likes and ratings
   * stay closed on unpublished work -- and the read is kept out of their
   * reading progress, which feeds streaks and badges.
   */
  const betaRead = story.data?.access === 'beta'
  const betaDraftStory = betaRead && story.data?.status === 'draft'
  const betaUnpublished =
    betaRead &&
    chapter.data !== null &&
    (betaDraftStory || chapter.data.publishedAt === null)

  const [progress, setProgress] = useState(0)

  /**
   * The passage an Ask This Book citation pointed at, if that is how the
   * reader got here. Router state rather than the URL: it belongs to the one
   * navigation, and a chapter link someone copies should not carry it.
   */
  const location = useLocation()
  const cited = (location.state as { cite?: unknown } | null)?.cite
  const citedQuote = typeof cited === 'string' && cited.trim() !== '' ? cited : null

  /**
   * A highlight picked from the highlights list in another chapter, which is
   * opened once this chapter has painted. Router state for the reason a
   * citation is: it belongs to the one navigation.
   */
  const jump = (location.state as { highlight?: unknown } | null)?.highlight
  const jumpTo = typeof jump === 'string' ? jump : null

  /**
   * Listen mode read the previous chapter to its end and turned the page, so
   * this one is read from its start. Router state, like a citation.
   */
  const listenNext = (location.state as { listen?: unknown } | null)?.listen === true

  /**
   * Restores the reader's place when a chapter opens and saves it as they
   * scroll, off the same `progress` fraction the bar above is drawn from. A
   * citation is somewhere more specific to be, so it wins over the restore.
   */
  useReadingProgress({
    storyId,
    chapter: betaUnpublished ? null : (chapter.data ?? null),
    scrollFraction: progress,
    skipRestore: citedQuote !== null || jumpTo !== null || listenNext,
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

  /* Ask about a passage ------------------------------------------------ */

  /**
   * The prose element, so a selection can be checked for being *inside* it.
   * A highlight that began in the chapter and ended in the comment box is not
   * a passage, and neither is one made in the footer.
   */
  const proseRef = useRef<HTMLDivElement | null>(null)

  /**
   * Takes the reader to a cited passage and marks it for a moment.
   *
   * After two frames, so the chapter's paragraphs are laid out; and again
   * while late media grows the page, for the reason the restore re-applies
   * (`useReadingProgress`), standing down as soon as the reader scrolls
   * themselves. Keyed on the navigation as well as the chapter, so following a
   * second citation into the chapter already open moves the page again.
   * Nothing found means nothing happens: the reader is at the right chapter.
   */
  const citedChapterId = chapter.data?.id ?? null
  useEffect(() => {
    const prose = proseRef.current
    if (citedQuote === null || citedChapterId === null || prose === null) return

    let marked: HTMLElement[] = []
    let observer: ResizeObserver | null = null
    let settle: ReturnType<typeof setTimeout> | undefined
    let fade: ReturnType<typeof setTimeout> | undefined
    let placedAt = 0

    const place = () => {
      const first = marked[0]
      if (!first) return
      first.scrollIntoView({ block: 'center' })
      placedAt = window.scrollY
    }

    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        marked = findPassage(prose, citedQuote)
        if (marked.length === 0) return

        for (const block of marked) block.classList.add('is-cited')
        place()
        fade = setTimeout(() => {
          for (const block of marked) block.classList.remove('is-cited')
        }, CITED_HIGHLIGHT_MS)

        if (typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(() => {
            if (Math.abs(window.scrollY - placedAt) > 48) {
              observer?.disconnect()
              return
            }
            place()
          })
          observer.observe(prose)
          settle = setTimeout(() => observer?.disconnect(), 1500)
        }
      }),
    )

    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      clearTimeout(settle)
      clearTimeout(fade)
      for (const block of marked) block.classList.remove('is-cited')
    }
  }, [citedQuote, citedChapterId, location.key])

  const [selection, setSelection] = useState<ChapterSelection | null>(null)
  const [anchorPoint, setAnchorPoint] = useState({ top: 0, left: 0 })
  const [explaining, setExplaining] = useState(false)

  /** The open note sheet: whose, and where its passage ends on the page. */
  const [noteFor, setNoteFor] = useState<{
    id: string
    autoFocus: boolean
    passageBottom: number
  } | null>(null)
  const [listOpen, setListOpen] = useState(false)
  const [highlighting, setHighlighting] = useState(false)

  /** Ask This Book. One sheet at a time: opening it closes the explain sheet. */
  const [asking, setAsking] = useState(false)
  const closeAsk = useCallback(() => setAsking(false), [])

  /** Beta feedback, and the passage it is about when opened from a selection. */
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [feedbackPassage, setFeedbackPassage] = useState<ChapterSelection | null>(null)
  const closeFeedback = useCallback(() => {
    setFeedbackOpen(false)
    setFeedbackPassage(null)
  }, [])
  const clearFeedbackPassage = useCallback(() => setFeedbackPassage(null), [])
  const openFeedback = useCallback((passage: ChapterSelection | null) => {
    setExplaining(false)
    setSelection(null)
    setAsking(false)
    setNoteFor(null)
    setListOpen(false)
    if (passage) window.getSelection()?.removeAllRanges()
    setFeedbackPassage(passage)
    setFeedbackOpen(true)
  }, [])

  /**
   * Offers the trigger when the reader has highlighted something explicable.
   *
   * `readSelection` returns null for anything unusable — collapsed, outside
   * the prose, or not locatable in the chapter source because the highlight
   * crossed formatting the renderer had removed. All of those produce no
   * button at all: offering an action that would fail is worse than offering
   * none, and the reader gets no explanation of a limitation they did not know
   * existed.
   */
  const onSelect = useCallback(() => {
    // `chapter.data` rather than the `current` alias below, which is declared
    // after the hooks.
    const chapterData = chapter.data
    // Explaining a passage asks a model on the caller's behalf, which needs one.
    if (!chapterData || !signedIn) return

    const found = readSelection(proseRef.current, chapterData.content)
    if (!found) {
      setSelection(null)
      setExplaining(false)
      return
    }

    const range = window.getSelection()?.getRangeAt(0)
    const rect = range?.getBoundingClientRect()
    if (rect) {
      setAnchorPoint({
        top: rect.bottom + window.scrollY + 8,
        // Clamped so a selection near the right edge does not open a panel
        // half off the screen.
        left: Math.max(
          12,
          Math.min(rect.left + window.scrollX, window.innerWidth - 360),
        ),
      })
    }

    setSelection(found)
    setExplaining(false)
    setNoteFor(null)
  }, [chapter.data, signedIn])

  /* Highlights and margin notes --------------------------------------- */

  /**
   * The reader's highlights across the whole story: the list sheet shows all
   * of them, and the page paints this chapter's.
   */
  const fetchedHighlights = useAsync(
    () =>
      signedIn && storyId
        ? highlightsApi.listHighlights(storyId)
        : Promise.resolve(null),
    [signedIn, storyId],
  )

  /**
   * Changes made on this page, laid over the fetched list rather than
   * reloading it, so a new highlight paints at once and the list does not
   * flash empty. Keyed by story, so it lapses on its own when the story
   * changes and the fetch takes over again.
   */
  const [edited, setEdited] = useState<{
    storyId: string
    items: SavedHighlight[]
  } | null>(null)
  const myHighlights =
    storyId && edited?.storyId === storyId ? edited.items : fetchedHighlights.data

  const editHighlights = useCallback(
    (change: (items: SavedHighlight[]) => SavedHighlight[]) => {
      if (!storyId) return
      setEdited({
        storyId,
        items: change(myHighlights ?? []).sort(
          (a, b) => a.chapterNumber - b.chapterNumber || a.start - b.start,
        ),
      })
    },
    [storyId, myHighlights],
  )

  const chapterData = chapter.data
  const chapterHighlights = useMemo(
    () =>
      (myHighlights ?? []).filter(
        (highlight) => highlight.found && highlight.chapterId === chapterData?.id,
      ),
    [myHighlights, chapterData?.id],
  )


  /** Each painted highlight's range, for hit-testing a tap and for jumping. */
  const rangesRef = useRef(new Map<string, Range>())
  const proseWrapRef = useRef<HTMLDivElement | null>(null)
  const [marginNotes, setMarginNotes] = useState<Array<{ id: string; top: number }>>([])

  /**
   * Paints this chapter's highlights over the prose, and places a margin
   * marker beside each one with a note.
   *
   * The markers are re-placed whenever the prose changes size -- a font or
   * width preference, a window resize, an image loading above -- since the
   * ranges are live but their position on screen is not. The observer's first
   * call, on `observe`, is the initial placement.
   */
  useEffect(() => {
    const prose = proseRef.current
    const wrap = proseWrapRef.current
    if (!prose || !wrap || !chapterData) return

    const index = indexText(prose)
    const ranges = new Map<string, Range>()
    for (const highlight of chapterHighlights) {
      const range = rangeForQuote(
        index,
        highlight.quote,
        highlight.start,
        chapterData.content.length,
      )
      if (range) ranges.set(highlight.id, range)
    }
    rangesRef.current = ranges

    const painted = (withNote: boolean) =>
      chapterHighlights
        .filter((highlight) => (highlight.note !== null) === withNote)
        .flatMap((highlight) => ranges.get(highlight.id) ?? [])
    paintHighlights('scribe-highlight', painted(false))
    paintHighlights('scribe-highlight-note', painted(true))

    const noted = chapterHighlights.filter(
      (highlight) => highlight.note !== null && ranges.has(highlight.id),
    )
    const place = () => {
      const origin = wrap.getBoundingClientRect().top
      setMarginNotes(
        noted.flatMap((highlight) => {
          const first = ranges.get(highlight.id)?.getClientRects()[0]
          return first ? [{ id: highlight.id, top: first.top - origin }] : []
        }),
      )
    }
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    observer?.observe(wrap)

    return () => {
      observer?.disconnect()
      rangesRef.current = new Map()
      paintHighlights('scribe-highlight', [])
      paintHighlights('scribe-highlight-note', [])
    }
  }, [chapterHighlights, chapterData])

  /** The highlight whose note is open is drawn stronger, so it is clear which. */
  useEffect(() => {
    const range = noteFor ? rangesRef.current.get(noteFor.id) : undefined
    paintHighlights('scribe-highlight-focus', range ? [range] : [])
    return () => paintHighlights('scribe-highlight-focus', [])
  }, [noteFor, chapterHighlights])

  /**
   * Opens a highlight's note sheet. From the list or a margin marker, the
   * page first scrolls the passage to the upper part of the window; from a
   * tap on the passage, the reader is already looking at it.
   */
  const openNote = useCallback(
    (id: string, options: { scroll: boolean; autoFocus?: boolean }) => {
      const range = rangesRef.current.get(id)
      if (!range) return

      if (options.scroll) {
        const rect = range.getBoundingClientRect()
        window.scrollTo({ top: window.scrollY + rect.top - window.innerHeight * 0.3 })
      }

      setExplaining(false)
      setSelection(null)
      setAsking(false)
      setListOpen(false)
      setFeedbackOpen(false)
      setNoteFor({
        id,
        autoFocus: options.autoFocus ?? false,
        passageBottom: range.getBoundingClientRect().bottom + window.scrollY,
      })
    },
    [],
  )

  /**
   * Arriving from the list with a highlight to open. Once per navigation:
   * the effect re-runs as notes are edited, and must not reopen a sheet the
   * reader has since closed.
   */
  const jumpedFor = useRef<string | null>(null)
  useEffect(() => {
    if (jumpTo === null || jumpedFor.current === location.key) return
    if (!chapterHighlights.some((highlight) => highlight.id === jumpTo)) return

    const frame = requestAnimationFrame(() => {
      jumpedFor.current = location.key
      openNote(jumpTo, { scroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [jumpTo, location.key, chapterHighlights, openNote])

  /** A tap on a highlighted passage opens its note. */
  const onProseClick = useCallback(
    (event: React.MouseEvent) => {
      if (!signedIn) return
      const selected = window.getSelection()
      if (selected && !selected.isCollapsed) return

      for (const [id, range] of rangesRef.current) {
        if (rangeContainsPoint(range, event.clientX, event.clientY)) {
          openNote(id, { scroll: false })
          return
        }
      }
    },
    [signedIn, openNote],
  )

  /** Keeps the current selection, then opens its note sheet ready to write in. */
  const highlightSelection = useCallback(async () => {
    if (!selection || !chapterData) return

    setHighlighting(true)
    try {
      const created = await highlightsApi.createHighlight({
        chapterId: chapterData.id,
        start: selection.start,
        end: selection.end,
      })
      editHighlights((items) => [
        ...items.filter((item) => item.id !== created.id),
        created,
      ])
      window.getSelection()?.removeAllRanges()
      setSelection(null)
      setNoteFor({
        id: created.id,
        autoFocus: true,
        passageBottom: anchorPoint.top - 8,
      })
    } catch (cause) {
      showToast({
        tone: 'error',
        message:
          cause instanceof Error ? cause.message : 'That could not be highlighted.',
      })
    } finally {
      setHighlighting(false)
    }
  }, [selection, chapterData, editHighlights, anchorPoint.top, showToast])

  const saveNote = useCallback(
    async (id: string, note: string | null) => {
      const updated = await highlightsApi.updateHighlightNote(id, note)
      editHighlights((items) =>
        items.map((item) => (item.id === updated.id ? updated : item)),
      )
      setNoteFor(null)
    },
    [editHighlights],
  )

  const removeHighlight = useCallback(
    async (id: string) => {
      await highlightsApi.deleteHighlight(id)
      editHighlights((items) => items.filter((item) => item.id !== id))
      setNoteFor(null)
      showToast({ message: 'Highlight removed.' })
    },
    [editHighlights, showToast],
  )

  /** From the list: here if it is in this chapter, else to its chapter. */
  const pickHighlight = useCallback(
    (highlight: SavedHighlight) => {
      setListOpen(false)
      if (highlight.chapterId === chapterData?.id) {
        openNote(highlight.id, { scroll: true })
        return
      }
      navigate(`/read/${slug}/${highlight.chapterNumber}`, {
        state: { highlight: highlight.id },
      })
    },
    [chapterData?.id, openNote, navigate, slug],
  )

  const closeNote = useCallback(() => setNoteFor(null), [])
  const closeList = useCallback(() => setListOpen(false), [])

  /* Listen mode ------------------------------------------------------- */

  /**
   * The chapter read aloud by the browser's own speech, a block at a time,
   * with the block being read marked on the page and kept in view. Because
   * the page follows the narration, the reading-progress save follows it
   * too, and "continue reading" resumes where listening stopped.
   *
   * Needs no account: nothing leaves the browser.
   */
  const listenRate = (LISTEN_RATES as readonly number[]).includes(preferences.listenRate)
    ? preferences.listenRate
    : 1
  const narration = useNarration(listenRate, preferences.listenVoice)
  const narrator = narration.narrator
  const narrationStatus = narration.state.status
  const narrationIndex = narration.state.index

  /** Whether the player is open. Narration stops when it is closed. */
  const [listening, setListening] = useState(false)
  /** The block being read has been scrolled out of view by the reader. */
  const [away, setAway] = useState(false)
  const articleRef = useRef<HTMLElement | null>(null)
  /** The blocks being read, in the narrator's order. */
  const blocksRef = useRef<HTMLElement[]>([])

  /** Reads this chapter, from a block or from the first one on screen. */
  const startNarration = useCallback(
    (from: number | 'visible') => {
      if (!narrator) return
      const blocks = narrationBlocks(articleRef.current)
      blocksRef.current = blocks
      narrator.load(blocks.map((block) => block.textContent ?? ''))
      if (blocks.length === 0) return

      const { top, bottom } = readingViewport()
      setAway(false)
      narrator.play(from === 'visible' ? firstVisibleBlock(blocks, top, bottom) : from)
    },
    [narrator],
  )

  const toggleNarration = useCallback(() => {
    if (!narrator) return
    if (narrationStatus === 'playing') narrator.pause()
    else if (narrationStatus === 'paused') narrator.resume()
    else startNarration('visible')
  }, [narrator, narrationStatus, startNarration])

  const closeListen = useCallback(() => {
    narrator?.stop()
    setListening(false)
  }, [narrator])

  /** Scrolls the block being read into the upper part of the window. */
  const followNarration = useCallback((block: HTMLElement) => {
    const { top, bottom } = readingViewport()
    const rect = block.getBoundingClientRect()
    window.scrollTo({
      top: window.scrollY + rect.top - top - (bottom - top) * 0.2,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    })
  }, [])

  const narrating =
    listening && (narrationStatus === 'playing' || narrationStatus === 'paused')

  /**
   * Marks the block being read, and keeps it in view -- unless the reader has
   * scrolled away from it, in which case they are left where they are (with
   * a way back in the player). The page only moves once the narration nears
   * the bottom of the window, not on every paragraph.
   */
  const followedRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!narrating) {
      followedRef.current = null
      return
    }
    const block = blocksRef.current[narrationIndex]
    if (!block) return

    block.classList.add('is-narrating')

    const previous = followedRef.current
    followedRef.current = block
    if (previous !== block && (previous === null || inReadingViewport(previous))) {
      const { top, bottom } = readingViewport()
      const rect = block.getBoundingClientRect()
      const roomy = rect.top >= top && rect.bottom <= bottom - (bottom - top) * 0.15
      if (!roomy) followNarration(block)
    }

    return () => block.classList.remove('is-narrating')
  }, [narrating, narrationIndex, followNarration])

  /** Notices the reader scrolling away from the narration, and back. */
  useEffect(() => {
    if (!narrating) return
    let timer: ReturnType<typeof setTimeout> | undefined
    // Debounced past a smooth scroll, which passes through "away" on its way.
    const check = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const block = blocksRef.current[narrationIndex]
        setAway(block ? !inReadingViewport(block) : false)
      }, 250)
    }
    window.addEventListener('scroll', check, { passive: true })
    check()
    return () => {
      clearTimeout(timer)
      window.removeEventListener('scroll', check)
    }
  }, [narrating, narrationIndex])

  /**
   * Another chapter is another text: whatever was being read stops. Turning
   * the page at the end of a chapter starts the next one again, below.
   */
  useEffect(() => {
    return () => {
      narrator?.stop()
      blocksRef.current = []
    }
  }, [chapterId, narrator])

  /** At the end of a chapter, a short pause, then on to the next one. */
  useEffect(() => {
    if (!listening || narrationStatus !== 'finished' || nextNumber === null) return
    const timer = setTimeout(() => {
      navigate(`/read/${slug}/${nextNumber}`, { state: { listen: true } })
      window.scrollTo({ top: 0 })
    }, LISTEN_NEXT_CHAPTER_MS)
    return () => clearTimeout(timer)
  }, [listening, narrationStatus, nextNumber, navigate, slug])

  /** Arriving from that page turn: read this chapter from the top, once. */
  const continuedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!listenNext || !chapterId || continuedFor.current === location.key) return
    const frame = requestAnimationFrame(() => {
      continuedFor.current = location.key
      setListening(true)
      startNarration(0)
    })
    return () => cancelAnimationFrame(frame)
  }, [listenNext, chapterId, location.key, startNarration])

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
  // An author reads their own chapters too, but may not like them.
  const isOwnStory = data !== null && data !== undefined && session?.user.id === data.author.id
  const current = chapter.data
  const hue = data?.genres[0]?.hue ?? 268
  const openHighlight = noteFor
    ? (myHighlights ?? []).find((highlight) => highlight.id === noteFor.id)
    : undefined
  /**
   * The sheets share the bottom of the window. While one of them is open the
   * listen bar steps aside -- the narration carries on -- and comes back when
   * it closes.
   */
  const otherSheetOpen =
    asking ||
    listOpen ||
    feedbackOpen ||
    (noteFor !== null && openHighlight !== undefined) ||
    (selection !== null && explaining)
  const chosenVoice = narration.voices.some(
    (voice) => voice.voiceURI === preferences.listenVoice,
  )
    ? preferences.listenVoice
    : null

  return (
    <div
      className={cn('reader', focusMode && 'is-focus', listening && 'is-listening')}
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

        <div className="reader__bar-actions" data-tour="reading-controls">
          {signedIn ? (
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
          ) : null}

          {signedIn && storyId ? (
            <Button
              variant="ghost"
              iconOnly
              aria-label="Your highlights"
              title="Your highlights"
              aria-pressed={listOpen}
              onClick={() => {
                setExplaining(false)
                setSelection(null)
                setAsking(false)
                setNoteFor(null)
                setFeedbackOpen(false)
                setListOpen((open) => !open)
              }}
              startIcon={<Icon name="highlight" size="1.1rem" />}
            />
          ) : null}

          {/*
            Only once the chapter list has arrived: the sheet's range picker
            is built from it, and a story with nothing readable has nothing
            to ask about.
          */}
          {signedIn && storyId && chapters.status === 'ready' && total > 0 && !betaDraftStory ? (
            <Button
              variant="ghost"
              iconOnly
              aria-label="Ask this book"
              title="Ask this book"
              aria-pressed={asking}
              onClick={() => {
                setExplaining(false)
                setSelection(null)
                setNoteFor(null)
                setListOpen(false)
                setFeedbackOpen(false)
                setAsking((open) => !open)
              }}
              startIcon={<Icon name="sparkle" size="1.1rem" />}
            />
          ) : null}

          {betaRead && storyId ? (
            <Button
              variant="ghost"
              iconOnly
              aria-label="Feedback for the author"
              title="Feedback for the author"
              aria-pressed={feedbackOpen}
              onClick={() => (feedbackOpen ? closeFeedback() : openFeedback(null))}
              startIcon={<Icon name="pen" size="1.1rem" />}
            />
          ) : null}

          {narrator ? (
            <Button
              variant="ghost"
              iconOnly
              aria-label={listening ? 'Stop listening' : 'Listen to this chapter'}
              title={listening ? 'Stop listening' : 'Listen to this chapter'}
              aria-pressed={listening}
              disabled={!current}
              onClick={() => {
                // Hidden behind another sheet counts as closed: bring it back.
                if (listening && !otherSheetOpen) {
                  closeListen()
                  return
                }
                setExplaining(false)
                setSelection(null)
                setAsking(false)
                setNoteFor(null)
                setListOpen(false)
                setFeedbackOpen(false)
                setListening(true)
                if (!narrating) startNarration('visible')
              }}
              startIcon={<Icon name="headphones" size="1.1rem" />}
            />
          ) : null}

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
          <article className="reader__article" ref={articleRef}>
            {/*
              The returning reader's catch-up, above chapter two and later.
              Renders nothing when there is no previous chapter they can open,
              and never calls a model until they ask it to.
            */}
            {signedIn && !betaDraftStory ? (
              <RecapCard
                key={`${slug}:${current.number}`}
                storyKey={slug}
                chapterNumber={current.number}
              />
            ) : null}

            {betaUnpublished ? (
              <div className="reader__beta" role="note">
                <span className="reader__beta-label">
                  <Icon name="lock" size="0.95em" />
                  Beta read
                </span>
                <span>
                  {betaDraftStory ? 'This story is' : 'This chapter is'} not
                  published yet. Your feedback goes only to{' '}
                  {data ? storyAuthorName(data.author) : 'the author'}.
                </span>
                <button
                  type="button"
                  className="reader__beta-action"
                  onClick={() => openFeedback(null)}
                >
                  Leave feedback
                </button>
              </div>
            ) : null}

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
            <div className="reader__prose-wrap" ref={proseWrapRef}>
              <div
                className="reader__prose"
                ref={proseRef}
                onMouseUp={onSelect}
                onTouchEnd={onSelect}
                onClick={onProseClick}
              >
                {renderChapter(current.content, current.multimedia, hue)}
              </div>

              {/*
                Beside each highlight with a note. Outside the prose element,
                so a selection or the highlight index never reads them.
              */}
              {marginNotes.map((marker) => (
                <button
                  key={marker.id}
                  type="button"
                  className="reader__margin-note"
                  style={{ top: `${marker.top}px` }}
                  aria-label="Open your note on this passage"
                  title="Your note"
                  onClick={() => openNote(marker.id, { scroll: false })}
                >
                  <Icon name="comment" size="0.85rem" />
                </button>
              ))}
            </div>

            {/*
              The offer, then the panel. Two steps rather than one because a
              reader selects text for all sorts of reasons — to copy it, to
              keep their place, by accident — and opening a panel on every
              highlight would be a model call nobody asked for.
            */}
            {selection && !explaining ? (
              <div
                className="selection-menu"
                role="group"
                aria-label="Selected passage"
                style={{
                  top: `${anchorPoint.top}px`,
                  left: `${anchorPoint.left}px`,
                }}
              >
                {/*
                  Only once the reader's highlights have loaded: the new one
                  is added to that list, and adding it to nothing would hide
                  the rest until the next visit.
                */}
                {fetchedHighlights.status === 'ready' ? (
                  <button
                    type="button"
                    className="selection-menu__action"
                    disabled={highlighting}
                    onClick={() => void highlightSelection()}
                  >
                    <Icon name="highlight" size="0.9em" />
                    Highlight
                  </button>
                ) : null}
                {betaRead ? (
                  <button
                    type="button"
                    className="selection-menu__action"
                    onClick={() => openFeedback(selection)}
                  >
                    <Icon name="pen" size="0.9em" />
                    Feedback
                  </button>
                ) : null}
                <button
                  type="button"
                  className="selection-menu__action"
                  onClick={() => {
                    setAsking(false)
                    setListOpen(false)
                    setNoteFor(null)
                    setFeedbackOpen(false)
                    setExplaining(true)
                  }}
                >
                  <Icon name="sparkle" size="0.9em" />
                  Ask about this
                </button>
              </div>
            ) : null}

            {selection && explaining ? (
              <ExplainSheet
                chapterId={current.id}
                selection={selection}
                selectionBottom={anchorPoint.top}
                onClose={() => {
                  setExplaining(false)
                  setSelection(null)
                }}
              />
            ) : null}

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
                  readOnly={isOwnStory || !signedIn || betaUnpublished}
                />

                {/*
                  Comments are public, so they stay closed on a chapter that is
                  not: a beta reader has the feedback sheet instead.
                */}
                {betaUnpublished ? null : (
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
                )}

                <ReportMenu
                  targetType="CHAPTER"
                  targetId={current.id}
                  noun="chapter"
                  hidden={!signedIn || isOwnStory || betaUnpublished}
                />
              </div>

              <nav
                className="reader__pager"
                aria-label="Chapter navigation"
                data-tour="chapter-navigation"
              >
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
            {showComments && !betaUnpublished ? (
              <section className="reader__comments" aria-label="Chapter comments">
                <header className="reader__comments-head">
                  <h2>Comments on this chapter</h2>
                  <p>Only what readers have said about chapter {current.number}.</p>
                </header>

                {signedIn ? (
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
                ) : (
                  <SignInPrompt action="comment on this chapter" />
                )}

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
                              readOnly={!signedIn}
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

      {/*
        Not keyed by chapter: turning the page with the sheet open keeps the
        conversation, and its range follows the chapter being read until the
        reader picks one themselves.
      */}
      {asking && storyId && current ? (
        <AskBookSheet
          storyId={storyId}
          storySlug={slug}
          chapters={chapters.data ?? []}
          chapterNumber={current.number}
          onCite={() => {
            setAsking(false)
            window.scrollTo({ top: 0 })
          }}
          onClose={closeAsk}
        />
      ) : null}

      {/* Beta feedback -------------------------------------------------- */}
      {feedbackOpen && betaRead && storyId && current ? (
        <BetaFeedbackSheet
          key={current.id}
          storyId={storyId}
          chapterId={current.id}
          chapterNumber={current.number}
          authorName={data ? storyAuthorName(data.author) : 'the author'}
          passage={feedbackPassage}
          onClearPassage={clearFeedbackPassage}
          onClose={closeFeedback}
        />
      ) : null}

      {/* Listen mode ---------------------------------------------------- */}
      {listening && narrator && !otherSheetOpen ? (
        <ListenBar
          state={narration.state}
          rate={listenRate}
          onRate={(listenRate) => update({ listenRate })}
          voices={narration.voices}
          voice={chosenVoice}
          onVoice={(listenVoice) => update({ listenVoice })}
          onToggle={toggleNarration}
          onSkip={(delta) => narrator.skip(delta)}
          away={away}
          onFollow={() => {
            const block = blocksRef.current[narrationIndex]
            if (block) followNarration(block)
          }}
          hasNextChapter={nextNumber !== null}
          onClose={closeListen}
        />
      ) : null}

      {/* Highlights ----------------------------------------------------- */}
      {noteFor && openHighlight ? (
        <HighlightNoteSheet
          key={openHighlight.id}
          highlight={openHighlight}
          passageBottom={noteFor.passageBottom}
          autoFocus={noteFor.autoFocus}
          onSave={(note) => saveNote(openHighlight.id, note)}
          onRemove={() => removeHighlight(openHighlight.id)}
          onClose={closeNote}
        />
      ) : null}

      {listOpen ? (
        <HighlightsSheet
          highlights={myHighlights}
          status={fetchedHighlights.status}
          error={fetchedHighlights.error}
          currentChapterId={current?.id ?? null}
          onPick={pickHighlight}
          onRemove={(highlight) => {
            void removeHighlight(highlight.id).catch(() =>
              showToast({ tone: 'error', message: 'That highlight could not be removed.' }),
            )
          }}
          onRetry={fetchedHighlights.reload}
          onClose={closeList}
        />
      ) : null}

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
