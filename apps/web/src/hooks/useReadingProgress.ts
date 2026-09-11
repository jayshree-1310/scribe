import { useEffect, useRef, useState } from 'react'
import { useDebouncedValue } from './useDebouncedValue'
import { ApiError } from '../lib/api-client'
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
 * debounce — see `blockedRef`.
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

  /** Set once the API says this reader may not save at all. */
  const blockedRef = useRef(false)

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

    /**
     * After paint. The chapter's paragraphs and any attachments have to be in
     * the document before `scrollHeight` means anything — measured during this
     * render it is still the previous chapter's height, or none at all.
     */
    const frame = requestAnimationFrame(() => {
      const scrollable = document.body.scrollHeight - window.innerHeight
      if (target > 0 && scrollable > 0) {
        window.scrollTo({ top: target * scrollable })
      }

      restoredOffsetRef.current = restoreOffset
      movedRef.current = false
      setRestoredChapterId(chapter.id)
    })

    return () => cancelAnimationFrame(frame)
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
    if (blockedRef.current) return
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

        // A reader who is not signed in cannot save at all, so stop asking.
        // Anything else may be transient and gets another chance next tick.
        if (
          cause instanceof ApiError &&
          (cause.status === 401 || cause.status === 403)
        ) {
          blockedRef.current = true
        }
      })

    return () => {
      active = false
    }
  }, [storyId, chapter, debouncedOffset, restoredChapterId])
}
