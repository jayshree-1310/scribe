import { useEffect, useRef, useState } from 'react'
import { useDebouncedValue } from './useDebouncedValue'
import { ApiError } from '../lib/api-client'
import { useAuth } from '../lib/auth'
import * as reading from '../data/reading-api'
import type { Chapter, ReadingProgress } from '../types/stories'

/**
 * How long the reader must sit still before a position is written.
 *
 * Long enough that flicking through a chapter costs one request rather than
 * one per scroll event, short enough that closing the tab shortly after
 * stopping still keeps the place.
 */
const SAVE_DELAY_MS = 1500

/**
 * How long after a restore the page is still allowed to grow under the reader.
 *
 * Chapter media reports its intrinsic size after the first paint, so the page
 * the restore measured is shorter than the one the reader ends up with. Long
 * enough to cover that; short enough that a late-loading image never yanks
 * somebody who has settled in to read.
 */
const RESTORE_SETTLE_MS = 3000

/**
 * How far the page may be from where the restore put it before we conclude the
 * reader moved it themselves. Sub-pixel scroll positions make an exact
 * comparison useless.
 */
const SETTLE_TOLERANCE_PX = 4

interface ReadingProgressInput {
  /** Absent until the story has loaded. */
  storyId: string | undefined
  /** The chapter on screen, or null while it loads. */
  chapter: Chapter | null
  /** 0–1 through that chapter, from the reader's own scroll listener. */
  scrollFraction: number
}

/** The saved position, tagged with the story it was loaded for. */
interface SavedFor {
  storyId: string
  progress: ReadingProgress | null
}

/**
 * Keeps the reader's place: restores it when a chapter opens, and saves it as
 * they scroll.
 *
 * Positions are character offsets into the chapter text rather than scroll
 * positions, because font size and reading width are preferences — a pixel
 * offset saved at one size restores to the wrong paragraph at another. The
 * conversion happens here, at the only point that knows both the chapter's
 * length and the viewport.
 *
 * Nothing this hook does may interrupt reading, so every failure is swallowed:
 * a position that cannot be restored just starts the chapter at the top, and
 * one that cannot be saved is lost. A signed-out reader is the common case of
 * that second branch, and gets one rejected request rather than one per
 * debounce — see `blockedForRef`.
 */
export function useReadingProgress({
  storyId,
  chapter,
  scrollFraction,
}: ReadingProgressInput): void {
  const [saved, setSaved] = useState<SavedFor | null>(null)

  /**
   * The chapter whose restore has finished. The save effect waits on it, so it
   * is state rather than a ref — and it is only ever set from the callback
   * that applies the scroll, never synchronously from an effect body.
   */
  const [restoredChapterId, setRestoredChapterId] = useState<string | null>(null)

  const { session } = useAuth()
  /**
   * Who the reader is, as far as saving is concerned. `null` is a signed-out
   * one, which is a perfectly good identity to refuse — and to stop refusing
   * the moment it changes.
   */
  const readerId = session?.user.id ?? null

  /**
   * The reader the API last refused a save for, or `undefined` while it has
   * refused none.
   *
   * Keyed on the reader rather than on the mount: a 401 says *this* reader may
   * not save, not that this page may not. Signing in with the reader open used
   * to save nothing until the next navigation, because the block outlived the
   * only thing that justified it.
   */
  const blockedForRef = useRef<string | null | undefined>(undefined)

  /**
   * The offset the current chapter was restored to, and whether the reader has
   * since moved. Together they tell a saved position apart from a page that is
   * merely still reporting the top — see the save effect.
   */
  const restoredOffsetRef = useRef(0)
  const movedRef = useRef(false)

  /* Load the saved position, once per story. */
  useEffect(() => {
    if (storyId === undefined) return

    let active = true
    reading.getProgress(storyId).then(
      (progress) => {
        if (active) setSaved({ storyId, progress })
      },
      () => {
        // Treated as "no saved position" rather than surfaced: the reader
        // asked for a chapter, not for their history.
        if (active) setSaved({ storyId, progress: null })
      },
    )

    return () => {
      active = false
    }
  }, [storyId])

  /* Restore, once per chapter, after the prose has been laid out. */
  useEffect(() => {
    if (chapter === null || storyId === undefined) return
    // Wait for the saved position for *this* story before deciding.
    if (saved === null || saved.storyId !== storyId) return
    if (restoredChapterId === chapter.id) return

    const progress = saved.progress
    // A position saved against a different chapter is not this chapter's, so
    // this one opens at the top.
    const restoreOffset =
      progress !== null && progress.chapterId === chapter.id
        ? progress.offset
        : 0
    const target = Math.min(
      1,
      restoreOffset / Math.max(1, chapter.content.length),
    )

    /** Where the restore last put the page, so we can tell it has been moved. */
    let appliedTop = 0
    let observer: ResizeObserver | null = null
    let settle: ReturnType<typeof setTimeout> | undefined

    const apply = (): void => {
      const scrollable = document.body.scrollHeight - window.innerHeight
      if (scrollable <= 0) return

      const top = target * scrollable
      // The page has not grown enough to have moved the reader's paragraph.
      if (Math.abs(top - appliedTop) < 1) return

      window.scrollTo({ top })
      appliedTop = top
    }

    const stopWatching = (): void => {
      observer?.disconnect()
      observer = null
      clearTimeout(settle)
    }

    /**
     * After paint. The chapter's paragraphs and any attachments have to be in
     * the document before `scrollHeight` means anything — measured during this
     * render it is still the previous chapter's height, or none at all.
     */
    const frame = requestAnimationFrame(() => {
      if (target > 0) {
        apply()

        /**
         * One frame is not the end of the layout. A chapter carrying an image
         * or a video is laid out twice — once at whatever height the browser
         * assumes, and again when the file reports its own — and the second
         * pass lands after this callback. The page measured above is therefore
         * shorter than the one the reader ends up with, and a proportional
         * restore against it lands short. So keep re-applying while the page
         * grows, and stop the moment the reader disagrees with where we put
         * them or `RESTORE_SETTLE_MS` says the layout has settled.
         */
        if (typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(() => {
            if (Math.abs(window.scrollY - appliedTop) > SETTLE_TOLERANCE_PX) {
              // The reader has scrolled. Their position beats the saved one.
              stopWatching()
              return
            }

            apply()
          })

          observer.observe(document.body)
          settle = setTimeout(stopWatching, RESTORE_SETTLE_MS)
        }
      }

      restoredOffsetRef.current = restoreOffset
      movedRef.current = false
      setRestoredChapterId(chapter.id)
    })

    return () => {
      cancelAnimationFrame(frame)
      stopWatching()
    }
  }, [chapter, saved, storyId, restoredChapterId])

  /**
   * The scroll fraction as a character offset. Derived rather than stored so
   * the debounce below trails one value, not two that can disagree.
   */
  const offset =
    chapter === null ? 0 : Math.round(scrollFraction * chapter.content.length)
  const debouncedOffset = useDebouncedValue(offset, SAVE_DELAY_MS)

  /* Save. */
  useEffect(() => {
    if (storyId === undefined || chapter === null) return
    // Refused for *this* reader. A different one — including the one who just
    // signed in — has not been refused anything yet.
    if (blockedForRef.current === readerId) return
    /**
     * Not until this chapter's restore has been applied. Otherwise the first
     * tick writes the top of the page over the position the reader is about to
     * be scrolled back to — and the next visit then restores to the top.
     *
     * Reaching this on a chapter just opened is also what records the visit,
     * so opening a chapter short enough to need no scrolling still counts as
     * reading it.
     */
    if (restoredChapterId !== chapter.id) return

    if (debouncedOffset > 0) movedRef.current = true

    /**
     * The restore scroll has been applied, but its scroll event has not landed
     * yet, so the page still reports the top. Saving 0 here would overwrite the
     * position just restored. Only until the reader moves once: after that, a
     * zero is a reader who really did scroll back to the beginning.
     */
    if (debouncedOffset === 0 && restoredOffsetRef.current > 0 && !movedRef.current) {
      return
    }

    let active = true

    reading
      .saveProgress({
        storyId,
        chapterId: chapter.id,
        offset: debouncedOffset,
      })
      .catch((cause: unknown) => {
        if (!active) return

        // A reader who is not signed in cannot save at all, so stop asking —
        // until they are somebody else. Anything else may be transient and
        // gets another chance next tick.
        if (
          cause instanceof ApiError &&
          (cause.status === 401 || cause.status === 403)
        ) {
          blockedForRef.current = readerId
        }
      })

    return () => {
      active = false
    }
  }, [storyId, chapter, debouncedOffset, restoredChapterId, readerId])
}
