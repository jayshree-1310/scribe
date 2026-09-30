import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useMatches, useNavigate } from 'react-router-dom'
import { useAuth } from '../../lib/auth'
import {
  INITIAL_TOUR_STATE,
  TourContext,
  persistTourState,
  readTourState,
  type TourContextValue,
  type TourReveal,
  type TourSample,
  type TourState,
} from '../../lib/tour'
import { setTourPreview } from '../../lib/tour-preview'
import * as readingApi from '../../data/reading-api'
import * as storiesApi from '../../data/stories-api'
import { TOUR_EXPLORE_ROUTE, TOUR_STEPS } from '../tour/tour-config'
import {
  SHEET_MAX_WIDTH,
  SHEET_RESERVE,
  bringIntoView,
  waitForTarget,
} from '../tour/tour-dom'
import { TourOverlay } from '../tour/TourOverlay'

const LAST_STEP = TOUR_STEPS.length - 1

function clampStep(index: number): number {
  return Math.max(0, Math.min(LAST_STEP, index))
}

/**
 * The story the tour opens to show off the story page and the reader.
 *
 * The one the reader is already partway through, when there is one: the tour
 * then shows them their own place and opens nothing they had not. Otherwise
 * the most-read story with a chapter to open. Null when the catalogue has
 * none, which skips both steps rather than showing an error page.
 */
async function findSample(): Promise<TourSample | null> {
  const [entry] = await readingApi.getContinueReading(1).catch(() => [])
  if (entry?.chapter) return { slug: entry.story.slug, chapter: entry.chapter.number }

  const page = await storiesApi.listStories({ sort: 'trending', limit: 12 })
  const story = page.items.find((item) => item.chapterCount > 0)
  if (!story) return null

  const [first] = await storiesApi.getChapters(story.slug)
  return first ? { slug: story.slug, chapter: first.number } : null
}

/**
 * Owns the product tour: which step it is on, getting the reader to that
 * step's page, and waiting for its target before anything is drawn.
 *
 * Mounted above every route (see `RootLayout` in `App.tsx`), because the tour
 * crosses shells: Home and Discover are the reader shell, the author studio
 * is the other one, and the reader page has no shell at all. Anything lower
 * would be torn down by the first navigation it made.
 *
 * **One step at a time, in three moves.** Resolve where the step happens and
 * navigate there if the reader is elsewhere; wait for its `data-tour` target
 * to render and finish loading; scroll it into view. Only then is the step
 * *presented*, which is what the overlay draws. A target that never comes is
 * skipped in the direction the reader was going, so a missing element can
 * slow the tour down but cannot strand anybody on it.
 *
 * **New readers get it unasked; nobody else does.** `OnboardingPage` starts
 * it as it hands a new account to the home page. Everybody else finds it in
 * the account menu. The state is persisted on every change, so a refresh --
 * even on the reader page, mid-tour -- resumes where it was.
 */
export function TourProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth()
  const navigate = useNavigate()
  const userId = session?.user.id ?? null

  /*
   * Whether the page on screen is one the tour may run on: a route that says
   * `handle: { tour: true }` in `App.tsx`. Elsewhere a tour in progress lies
   * dormant -- nothing drawn, nothing navigated -- and picks up again when the
   * reader is back in the app.
   */
  const matches = useMatches()
  const onTourRoute = matches.some(
    (match) => (match.handle as { tour?: boolean } | undefined)?.tour === true,
  )

  const [state, setState] = useState<TourState>(() =>
    userId ? readTourState(userId) : INITIAL_TOUR_STATE,
  )
  const [direction, setDirection] = useState<1 | -1>(1)
  /** The step whose target has been found; lags `currentStep` while it loads. */
  const [presentedStep, setPresentedStep] = useState<number | null>(null)

  // The overlay stays mounted after closing for its exit animation. Both of
  // these are adjusted during render -- the pattern `Dialog` uses -- rather
  // than inside an effect.
  const [exiting, setExiting] = useState(false)
  const [wasOpen, setWasOpen] = useState(state.isOpen)

  // A different account signed in (or nobody): its own record, from scratch.
  const [owner, setOwner] = useState(userId)
  if (owner !== userId) {
    const next = userId ? readTourState(userId) : INITIAL_TOUR_STATE
    setOwner(userId)
    setState(next)
    setWasOpen(next.isOpen)
    setExiting(false)
    setPresentedStep(null)
  } else if (wasOpen !== state.isOpen) {
    setWasOpen(state.isOpen)
    setExiting(!state.isOpen)
  }

  useEffect(() => {
    if (userId) persistTourState(userId, state)
  }, [userId, state])

  /**
   * The parts the tour can open -- the shell's drawer, the Scribble panel --
   * and whether it currently wants each one open.
   *
   * Refs, not state: handing a part over must not re-render the tour. What is
   * wanted is kept apart from who holds the part, because the holder can
   * change mid-step -- a navigation that swaps shells builds a new Scribble --
   * and one that registers while its part is wanted open is opened at once.
   */
  const revealersRef = useRef(new Map<TourReveal, (open: boolean) => void>())
  const wantedRef = useRef(new Map<TourReveal, boolean>())

  const registerReveal = useCallback(
    (name: TourReveal, reveal: (open: boolean) => void) => {
      revealersRef.current.set(name, reveal)
      if (wantedRef.current.get(name)) reveal(true)
      return () => {
        if (revealersRef.current.get(name) === reveal) revealersRef.current.delete(name)
      }
    },
    [],
  )

  const reveal = useCallback((name: TourReveal, open: boolean) => {
    if ((wantedRef.current.get(name) ?? false) === open) return
    wantedRef.current.set(name, open)
    revealersRef.current.get(name)?.(open)
  }, [])

  const revealDrawer = useCallback((open: boolean) => reveal('drawer', open), [reveal])

  const { isOpen, currentStep, sample } = state
  const running = userId !== null && isOpen && onTourRoute

  /*
   * Mark the story and chapter requests made while the tour is open, so the
   * API does not count them as reading. A layout effect because a page the
   * tour resumes on after a refresh -- the reader, say -- is mounted in the
   * same commit, and its data effects must not run before the flag is set.
   */
  useLayoutEffect(() => {
    setTourPreview(running)
    return () => setTourPreview(false)
  }, [running])

  /* Route, wait, scroll, present. */
  useEffect(() => {
    if (!running) return

    const index = clampStep(currentStep)
    const step = TOUR_STEPS[index]
    const controller = new AbortController()
    const { signal } = controller

    function skip(): void {
      // The welcome and the send-off have no target to miss, so moving past
      // a missing one can never run off either end.
      setState((current) => ({
        ...current,
        currentStep: clampStep(current.currentStep + direction),
      }))
    }

    async function run(): Promise<void> {
      let path: string | null

      if (step.route === null || typeof step.route === 'string') {
        path = step.route
      } else if (sample === null) {
        const found = await findSample().catch(() => null)
        if (signal.aborted) return
        // Storing it re-runs this effect, which then has a path to go to.
        if (found) setState((current) => ({ ...current, sample: found }))
        else skip()
        return
      } else {
        path =
          step.route.sample === 'story'
            ? `/story/${sample.slug}`
            : `/read/${sample.slug}/${sample.chapter}`
      }

      if (path !== null && window.location.pathname !== path) {
        await navigate(path)
        if (signal.aborted) return
      }

      // Open what the target lives inside before looking for it, and close
      // what the last step opened. The drawer is the overlay's business: it
      // only knows whether it is needed once it has seen the page.
      reveal('scribble', step.reveal === 'scribble')

      // A centred card has nothing to point at, but it still waits for the
      // page it sits over, rather than opening on a screen mid-navigation.
      const anchor = step.target ?? (path === null ? null : 'app')
      const found = anchor === null ? null : await waitForTarget(anchor, signal)
      if (signal.aborted) return

      if (step.target !== null) {
        if (found === null) {
          skip()
          return
        }
        if (!found.inDrawer) {
          const sheet = document.documentElement.clientWidth <= SHEET_MAX_WIDTH
          bringIntoView(found.element, sheet ? SHEET_RESERVE : 0)
        }
      }

      setPresentedStep(index)
    }

    void run()
    return () => controller.abort()
  }, [running, currentStep, sample, direction, navigate, reveal])

  // Whatever the tour opened, it closes again when it stops.
  useEffect(() => {
    if (!running) reveal('scribble', false)
  }, [running, reveal])

  /*
   * Browser back or forward mid-tour: the reader has gone somewhere of their
   * own accord. The tour steps aside rather than dragging them back, which is
   * what re-running the current step would do. The tour's own navigations are
   * pushes, which never fire `popstate`.
   */
  useEffect(() => {
    if (!isOpen) return
    function onPopState(): void {
      setState((current) => ({ ...current, isOpen: false }))
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [isOpen])

  const startTour = useCallback(() => {
    setDirection(1)
    setPresentedStep(null)
    // A fresh sample per run: what the reader is partway through changes.
    setState((current) => ({ ...current, isOpen: true, currentStep: 0, sample: null }))
  }, [])

  const nextStep = useCallback(() => {
    setDirection(1)
    setState((current) =>
      current.currentStep >= LAST_STEP
        ? { ...current, isOpen: false, completed: true, currentStep: 0 }
        : { ...current, currentStep: current.currentStep + 1 },
    )
  }, [])

  const previousStep = useCallback(() => {
    setDirection(-1)
    setState((current) => ({ ...current, currentStep: clampStep(current.currentStep - 1) }))
  }, [])

  const skipTour = useCallback(() => {
    setState((current) => ({ ...current, isOpen: false, currentStep: 0 }))
  }, [])

  const completeTour = useCallback(() => {
    setState((current) => ({ ...current, isOpen: false, completed: true, currentStep: 0 }))
  }, [])

  const exploreScribe = useCallback(() => {
    completeTour()
    void navigate(TOUR_EXPLORE_ROUTE)
  }, [completeTour, navigate])

  const onExited = useCallback(() => {
    setExiting(false)
    setPresentedStep(null)
  }, [])

  const value = useMemo<TourContextValue>(
    () => ({
      state,
      direction,
      presentedStep,
      startTour,
      nextStep,
      previousStep,
      skipTour,
      completeTour,
      restartTour: startTour,
      registerReveal,
    }),
    [
      state,
      direction,
      presentedStep,
      startTour,
      nextStep,
      previousStep,
      skipTour,
      completeTour,
      registerReveal,
    ],
  )

  return (
    <TourContext.Provider value={value}>
      {children}
      {userId && onTourRoute && (isOpen || exiting) ? (
        <TourOverlay
          steps={TOUR_STEPS}
          currentStep={clampStep(currentStep)}
          presentedStep={presentedStep}
          direction={direction}
          closing={!isOpen}
          onNext={nextStep}
          onBack={previousStep}
          onSkip={skipTour}
          onFinish={completeTour}
          onRestart={startTour}
          onExplore={exploreScribe}
          onExited={onExited}
          revealDrawer={revealDrawer}
        />
      ) : null}
    </TourContext.Provider>
  )
}
