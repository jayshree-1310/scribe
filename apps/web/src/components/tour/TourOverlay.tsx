import { useEffect, useId, useRef, useState } from 'react'
import type {
  AnimationEvent,
  CSSProperties,
  KeyboardEvent,
  MouseEvent,
  SyntheticEvent,
} from 'react'
import { cn } from '../../lib/cn'
import { Spinner } from '../ui/Spinner'
import type { TourPlacement, TourStep } from './tour-config'
import {
  SHEET_MAX_WIDTH,
  placeCard,
  resolveTarget,
  sheetDock,
  spotFor,
  type Spot,
} from './tour-dom'
import { TourTooltip } from './TourTooltip'
import './tour.css'

type Mode = 'float' | 'sheet' | 'centre'

interface Layout {
  spot: Spot
  /** Nothing lit: the hole is closed to a point and the whole page is dimmed. */
  dim: boolean
  mode: Mode
  /** Null until the card has been measured, which takes one frame. */
  card: { x: number; y: number } | null
  side: TourPlacement | null
  arrow: number
  dock: 'top' | 'bottom'
  /** First frame of the spot: placed, not glided in from the corner. */
  spotFresh: boolean
  /** First frame the card has a position: likewise. */
  cardFresh: boolean
}

function round(value: number): number {
  return Math.round(value * 2) / 2
}

function sameLayout(a: Layout, b: Layout): boolean {
  return (
    round(a.spot.x) === round(b.spot.x) &&
    round(a.spot.y) === round(b.spot.y) &&
    round(a.spot.width) === round(b.spot.width) &&
    round(a.spot.height) === round(b.spot.height) &&
    round(a.spot.radius) === round(b.spot.radius) &&
    a.dim === b.dim &&
    a.mode === b.mode &&
    round(a.card?.x ?? -1) === round(b.card?.x ?? -1) &&
    round(a.card?.y ?? -1) === round(b.card?.y ?? -1) &&
    a.side === b.side &&
    round(a.arrow) === round(b.arrow) &&
    a.dock === b.dock &&
    a.spotFresh === b.spotFresh &&
    a.cardFresh === b.cardFresh
  )
}

/** A zero-size spot at the centre of another: the hole, closed. */
function collapse(spot: Spot): Spot {
  return {
    x: spot.x + spot.width / 2,
    y: spot.y + spot.height / 2,
    width: 0,
    height: 0,
    radius: 0,
  }
}

interface TourOverlayProps {
  steps: TourStep[]
  currentStep: number
  /** The step whose target was found; lags `currentStep` while it loads. */
  presentedStep: number | null
  direction: 1 | -1
  closing: boolean
  onNext: () => void
  onBack: () => void
  onSkip: () => void
  onFinish: () => void
  onRestart: () => void
  onExplore: () => void
  /** The exit animation has finished and the overlay can go. */
  onExited: () => void
  revealDrawer: (open: boolean) => void
}

/**
 * The dimmed page, the lit target and the card beside it.
 *
 * **A modal `<dialog>`**, like `Dialog`: the top layer puts it above every
 * z-index in the app -- the sticky bars, the drawer, the Scribble panel,
 * toasts, dropdowns and any dialog already open -- and the platform makes the
 * page behind it inert, so a stray click cannot follow a link out from under
 * the tour, and Tab stays within the card.
 *
 * **The spotlight is one element.** It sits over the target, and a huge
 * spread shadow *is* the dimming, so the hole and the dark around it cannot
 * disagree, and moving between steps is a single transition of its box.
 * Nothing about the target's own layout is touched.
 *
 * **Measured every frame, not once.** The target is looked up and measured
 * on each animation frame while the tour is open, so the card follows it
 * through a resize, a drawer sliding in, a banner arriving above it or a font
 * swapping in, and swaps to the tab bar's copy of a link when the window gets
 * narrow enough. State only changes when the geometry does, so a still page
 * costs a lookup and a comparison per frame, and no renders.
 */
export function TourOverlay({
  steps,
  currentStep,
  presentedStep,
  direction,
  closing,
  onNext,
  onBack,
  onSkip,
  onFinish,
  onRestart,
  onExplore,
  onExited,
  revealDrawer,
}: TourOverlayProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const anchorRef = useRef<HTMLDivElement>(null)
  /** Where the last lit target was, so the hole closes over it while the next loads. */
  const lastSpotRef = useRef<Spot | null>(null)
  const id = useId()
  const titleId = `${id}-title`
  const descriptionId = `${id}-description`

  const [layout, setLayout] = useState<Layout | null>(null)
  const [nudging, setNudging] = useState(false)

  const shownStep = presentedStep === null ? null : (steps[presentedStep] ?? null)
  const waiting = !closing && presentedStep !== currentStep
  const placed = layout?.card != null

  /* Open as a modal, hold the page still, and give focus back afterwards. */
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!dialog.open) dialog.showModal()

    // `showModal()` does not stop the page behind it from scrolling.
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.body.style.overflow = overflow
      if (dialog.open) dialog.close()
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])

  /* Follow the target. */
  useEffect(() => {
    if (closing) {
      revealDrawer(false)
      return
    }

    let frame = 0
    /** What the drawer was last told, so it is told only on a change. */
    let drawerOpen: boolean | null = null

    function tick(): void {
      const viewport = {
        width: document.documentElement.clientWidth,
        height: window.innerHeight,
      }
      const found = !waiting && shownStep?.target ? resolveTarget(shownStep.target) : null

      // While the next step loads, the drawer stays as the last one left it,
      // so two drawer links in a row do not make it flap shut in between.
      if (!waiting) {
        const want = found?.inDrawer ?? false
        if (want !== drawerOpen) {
          drawerOpen = want
          revealDrawer(want)
        }
      }

      let spot: Spot
      let dim: boolean
      if (found) {
        spot = spotFor(found.element)
        lastSpotRef.current = spot
        dim = false
      } else {
        spot = collapse(
          lastSpotRef.current ?? {
            x: 0,
            y: 0,
            width: viewport.width,
            height: viewport.height,
            radius: 0,
          },
        )
        dim = true
      }

      const anchor = anchorRef.current
      const size = anchor ? { width: anchor.offsetWidth, height: anchor.offsetHeight } : null
      const mode: Mode = !found ? 'centre' : viewport.width <= SHEET_MAX_WIDTH ? 'sheet' : 'float'

      setLayout((previous) => {
        let next: Layout

        if (waiting && previous) {
          // The old card fades where it is; only the hole moves.
          next = { ...previous, spot, dim, spotFresh: false, cardFresh: false }
        } else {
          const float =
            size && mode === 'float'
              ? placeCard(spot, size, viewport, shownStep?.placement)
              : null
          const card = !size
            ? null
            : float
              ? { x: float.x, y: float.y }
              : mode === 'centre'
                ? {
                    x: Math.max(16, (viewport.width - size.width) / 2),
                    y: Math.max(16, (viewport.height - size.height) / 2),
                  }
                : { x: 0, y: 0 }

          next = {
            spot,
            dim,
            mode,
            card,
            side: float?.side ?? null,
            arrow: float?.arrow ?? 0,
            dock: mode === 'sheet' && size ? sheetDock(spot, size.height, viewport.height) : 'bottom',
            spotFresh: previous === null,
            cardFresh: previous?.card == null && card !== null,
          }
        }

        return previous && sameLayout(previous, next) ? previous : next
      })

      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [closing, waiting, shownStep, revealDrawer])

  /* Focus the way forward whenever a step lands. */
  useEffect(() => {
    if (closing || waiting || !placed) return
    dialogRef.current
      ?.querySelector<HTMLElement>('[data-tour-primary]')
      ?.focus({ preventScroll: true })
  }, [presentedStep, waiting, closing, placed])

  /* A safety net for the exit, should `animationend` never arrive. */
  useEffect(() => {
    if (!closing) return
    const timer = window.setTimeout(onExited, 500)
    return () => window.clearTimeout(timer)
  }, [closing, onExited])

  function onKeyDown(event: KeyboardEvent<HTMLDialogElement>): void {
    // The page underneath has shortcuts of its own -- the reader turns
    // chapters on the arrow keys and hides its chrome on F -- and a key meant
    // for the tour must not reach them as well.
    event.stopPropagation()
    if (closing || waiting) return

    if (event.key === 'ArrowRight') {
      event.preventDefault()
      onNext()
    } else if (event.key === 'ArrowLeft' && currentStep > 0) {
      event.preventDefault()
      onBack()
    }
  }

  function onCancel(event: SyntheticEvent<HTMLDialogElement>): void {
    // Esc skips, but through state, so the exit animation plays first.
    event.preventDefault()
    if (!closing) onSkip()
  }

  function onNativeClose(): void {
    // The browser may close a modal itself -- a second Esc in quick
    // succession, in Chromium. Still open means this was our own close and
    // reopen (StrictMode runs effects twice in development).
    if (dialogRef.current?.open || closing) return
    onSkip()
  }

  function onClick(event: MouseEvent<HTMLDialogElement>): void {
    // A click on the dimmed page goes nowhere, and the card says so.
    if (closing || waiting) return
    if (event.target instanceof Node && anchorRef.current?.contains(event.target)) return
    setNudging(true)
  }

  function onAnimationEnd(event: AnimationEvent<HTMLDialogElement>): void {
    if (event.target === event.currentTarget && event.animationName === 'tour-out') onExited()
  }

  const announcement = waiting
    ? 'Loading the next step of the tour.'
    : shownStep && presentedStep !== null
      ? `Step ${presentedStep + 1} of ${steps.length}: ${shownStep.title}. ${shownStep.description}`
      : ''

  const spotStyle: CSSProperties | undefined = layout
    ? {
        transform: `translate(${layout.spot.x}px, ${layout.spot.y}px)`,
        width: layout.spot.width,
        height: layout.spot.height,
        borderRadius: layout.spot.radius,
      }
    : undefined

  const anchorStyle: CSSProperties | undefined =
    layout?.card && layout.mode !== 'sheet'
      ? { transform: `translate(${layout.card.x}px, ${layout.card.y}px)` }
      : undefined

  return (
    <dialog
      ref={dialogRef}
      className="tour"
      data-tour-overlay=""
      data-phase={closing ? 'closing' : waiting ? 'waiting' : 'shown'}
      aria-labelledby={shownStep ? titleId : undefined}
      aria-describedby={shownStep ? descriptionId : undefined}
      aria-label={shownStep ? undefined : 'Product tour'}
      onCancel={onCancel}
      onClose={onNativeClose}
      onKeyDown={onKeyDown}
      onClick={onClick}
      onAnimationEnd={onAnimationEnd}
    >
      <div
        className={cn(
          'tour__spot',
          layout?.dim !== false && 'is-dim',
          waiting && 'is-waiting',
          layout?.spotFresh && 'is-fresh',
        )}
        style={spotStyle}
        aria-hidden="true"
      />

      {shownStep && presentedStep !== null ? (
        <div
          ref={anchorRef}
          className={cn(
            'tour__anchor',
            !placed && 'is-measuring',
            layout?.cardFresh && 'is-fresh',
          )}
          data-mode={layout?.mode ?? 'centre'}
          data-dock={layout?.dock}
          data-side={layout?.side ?? undefined}
          style={anchorStyle}
        >
          <div
            className={cn('tour__nudge', nudging && 'is-nudging')}
            onAnimationEnd={(event) => {
              if (event.animationName === 'tour-nudge') setNudging(false)
            }}
          >
            <div className="tour__card" data-state={waiting ? 'waiting' : 'shown'}>
              {layout?.mode === 'float' && layout.side ? (
                <span
                  className="tour__arrow"
                  style={{ '--tour-arrow': `${layout.arrow}px` } as CSSProperties}
                  aria-hidden="true"
                />
              ) : null}

              <TourTooltip
                step={shownStep}
                index={presentedStep}
                total={steps.length}
                direction={direction}
                titleId={titleId}
                descriptionId={descriptionId}
                onNext={onNext}
                onBack={onBack}
                onSkip={onSkip}
                onFinish={onFinish}
                onRestart={onRestart}
                onExplore={onExplore}
              />
            </div>
          </div>
        </div>
      ) : null}

      {waiting ? (
        <div className="tour__loading">
          <Spinner />
          <span>Loading…</span>
        </div>
      ) : null}

      <p className="visually-hidden" aria-live="polite">
        {announcement}
      </p>
    </dialog>
  )
}
