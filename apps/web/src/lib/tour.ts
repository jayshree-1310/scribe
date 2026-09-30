/**
 * The product tour's state, and where it is kept between visits.
 *
 * The tour walks a new reader through Scribe across several pages, so its
 * state has to outlive any one of them: `TourProvider` sits above every route
 * and owns it, and this module is the part everything else may import --
 * the context, the hook, and the storage.
 *
 * **Why `localStorage` and not the server.** Onboarding moved its flag to a
 * column because it *gates routing*: a stale local copy let a refresh carry
 * somebody past a form. Nothing routes on the tour. What a lost record costs
 * -- a new browser, cleared site data -- is that the tour is not resumed and
 * is offered from the account menu instead, which is not worth a migration.
 * It is keyed per account, so a shared browser keeps each reader's own.
 */

import { createContext, useContext } from 'react'

export const TOUR_STORAGE_PREFIX = 'scribe:tour'

/** The story the tour opens to show off the story page and the reader. */
export interface TourSample {
  slug: string
  chapter: number
}

export interface TourState {
  isOpen: boolean
  currentStep: number
  /** True once the reader has reached the end; never offered unasked again. */
  completed: boolean
  /**
   * Chosen once per run and remembered, so Back lands on the same story Next
   * left, and a refresh on the reader page resumes the same chapter.
   */
  sample: TourSample | null
}

/**
 * Parts of the app the tour can open for a step, because what it points at
 * lives inside them: the shell's navigation drawer on a tablet, where the
 * sidebar is hidden, and the Scribble panel.
 */
export type TourReveal = 'drawer' | 'scribble'

export const INITIAL_TOUR_STATE: TourState = {
  isOpen: false,
  currentStep: 0,
  completed: false,
  sample: null,
}

export interface TourContextValue {
  state: TourState
  /** Which way the reader last moved, so a missing step is skipped the same way. */
  direction: 1 | -1
  /** The step whose target has been found and is on screen; null while waiting. */
  presentedStep: number | null
  startTour: () => void
  nextStep: () => void
  previousStep: () => void
  /** Closes the tour without finishing it. */
  skipTour: () => void
  completeTour: () => void
  /** Starts again from the welcome, wherever the reader is. */
  restartTour: () => void
  /**
   * Lets a component hand over its open state -- the shell its drawer,
   * Scribble its panel -- so a step can open it to point at what is inside.
   * Returns the unregister function.
   */
  registerReveal: (name: TourReveal, reveal: (open: boolean) => void) => () => void
}

export const TourContext = createContext<TourContextValue | null>(null)

export function useTour(): TourContextValue {
  const context = useContext(TourContext)
  if (!context) throw new Error('useTour must be used inside <TourProvider>.')
  return context
}

/**
 * Whether a tour is on screen, for code that must behave differently while it
 * is -- reading progress, chiefly. Answers false rather than throwing outside
 * the provider: nothing about reading may depend on the tour existing.
 */
export function useIsTouring(): boolean {
  return useContext(TourContext)?.state.isOpen ?? false
}

function storageKey(userId: string): string {
  return `${TOUR_STORAGE_PREFIX}:${userId}`
}

function isSample(value: unknown): value is TourSample {
  const sample = value as TourSample | null
  return (
    typeof sample?.slug === 'string' &&
    typeof sample.chapter === 'number' &&
    Number.isInteger(sample.chapter)
  )
}

export function readTourState(userId: string): TourState {
  try {
    const raw = localStorage.getItem(storageKey(userId))
    if (!raw) return INITIAL_TOUR_STATE
    const parsed = JSON.parse(raw) as Partial<TourState>
    return {
      isOpen: parsed.isOpen === true,
      currentStep:
        typeof parsed.currentStep === 'number' && parsed.currentStep >= 0
          ? Math.floor(parsed.currentStep)
          : 0,
      completed: parsed.completed === true,
      sample: isSample(parsed.sample) ? parsed.sample : null,
    }
  } catch {
    return INITIAL_TOUR_STATE
  }
}

export function persistTourState(userId: string, state: TourState): void {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(state))
  } catch {
    // Non-fatal: the tour simply will not resume after a reload.
  }
}
