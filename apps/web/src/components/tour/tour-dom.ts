import type { TourPlacement } from './tour-config'

/**
 * Everything the tour needs to know about the page underneath it: which
 * element an anchor means right now, when it has finished loading, how to get
 * it on screen, and where the card fits beside it.
 *
 * Plain functions over the DOM, measured fresh each time, so nothing here
 * holds a coordinate that a resize, a font load or a banner could make stale.
 */

/** Marks the shell's navigation drawer, which can be slid open to show a link. */
const DRAWER = '[data-tour-drawer]'

/** Marks the tour's own overlay, whose DOM churn says nothing about the page. */
export const OVERLAY_ATTRIBUTE = 'data-tour-overlay'

/** Below this the card docks to an edge as a sheet; matches the phone tab bar. */
export const SHEET_MAX_WIDTH = 767

/** Roughly how tall a docked sheet gets, kept clear when scrolling a target up. */
export const SHEET_RESERVE = 260

/** Longest the tour waits for a target before skipping the step. */
const TARGET_TIMEOUT_MS = 7000

/**
 * How long the page must go without changing, with nothing still loading, for
 * a missing target to count as "not coming" before the timeout.
 */
const QUIET_MS = 900

/** Space between the lit element and the outline drawn around it. */
const SPOT_PADDING = 6

/** Space between the outline and the card. */
const CARD_GAP = 16

/** The card never comes closer to the viewport's edge than this. */
const EDGE = 16

/** Keeps the card's arrow off its rounded corners. */
const ARROW_INSET = 24

/** Clears the sticky top bars (the shell's and the reader's) when scrolling. */
const TOP_INSET = 80

const FALLBACK_ORDER: TourPlacement[] = ['right', 'bottom', 'left', 'top']

export interface ResolvedTarget {
  element: HTMLElement
  /** The copy in the navigation drawer, which has to be slid open first. */
  inDrawer: boolean
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface Spot extends Box {
  radius: number
}

export interface CardPlacement {
  x: number
  y: number
  side: TourPlacement
  /** Where along the facing edge the arrow sits, in px from the card's corner. */
  arrow: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function isShown(element: HTMLElement): boolean {
  // The closed drawer is `inert` and `aria-hidden`, and so is the Scribble
  // panel while it is shut: present, laid out, and not really there.
  if (element.closest('[inert], [aria-hidden="true"]')) return false
  // No boxes at all: `display: none` on it or on an ancestor.
  if (element.getClientRects().length === 0) return false
  return getComputedStyle(element).visibility !== 'hidden'
}

/** Whether the drawer holding this element can be opened at this width. */
function canRevealDrawer(element: HTMLElement): boolean {
  const drawer = element.closest<HTMLElement>(DRAWER)
  return drawer !== null && getComputedStyle(drawer).display !== 'none'
}

/**
 * The element an anchor means right now.
 *
 * The first copy on screen wins. A drawer copy is chosen only when nothing
 * else is showing, which is what happens to the sidebar links on a tablet:
 * there is no sidebar and no tab bar, so the tour slides the drawer open.
 */
export function resolveTarget(anchor: string): ResolvedTarget | null {
  const matches = Array.from(
    document.querySelectorAll<HTMLElement>(`[data-tour="${CSS.escape(anchor)}"]`),
  )

  const shown = matches.find((element) => !element.closest(DRAWER) && isShown(element))
  if (shown) return { element: shown, inDrawer: false }

  const drawer = matches.find((element) => element.closest(DRAWER) && canRevealDrawer(element))
  return drawer ? { element: drawer, inDrawer: true } : null
}

/**
 * Whether a target is the real thing rather than its loading placeholder.
 * Every async surface in the app draws a `Skeleton` while it waits, so one
 * inside the target means its data has not arrived.
 */
function isSettled(element: HTMLElement): boolean {
  return !element.matches('.skeleton') && element.querySelector('.skeleton') === null
}

function pageIsLoading(): boolean {
  return document.querySelector('.skeleton') !== null
}

/**
 * Waits for an anchor to appear and finish loading.
 *
 * Checks on every DOM change and on a short interval, since CSS can reveal an
 * element without a mutation. Gives up after `TARGET_TIMEOUT_MS`, or sooner
 * once the page has gone quiet with nothing still loading -- a reader with
 * nothing to resume should not stare at a spinner for seven seconds waiting
 * for a card that will never render. Resolves null on either, and on abort.
 */
export function waitForTarget(
  anchor: string,
  signal: AbortSignal,
): Promise<ResolvedTarget | null> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(null)
      return
    }

    const started = performance.now()
    let lastChange = started
    let settled = false

    const observer = new MutationObserver((records) => {
      const external = records.some(
        (record) =>
          !(record.target instanceof Element) ||
          !record.target.closest(`[${OVERLAY_ATTRIBUTE}]`),
      )
      if (!external) return
      lastChange = performance.now()
      check()
    })

    const interval = window.setInterval(() => check(), 120)

    function finish(result: ResolvedTarget | null): void {
      if (settled) return
      settled = true
      observer.disconnect()
      window.clearInterval(interval)
      signal.removeEventListener('abort', onAbort)
      resolve(result)
    }

    function onAbort(): void {
      finish(null)
    }

    function check(): void {
      if (settled) return
      const found = resolveTarget(anchor)
      if (found && isSettled(found.element)) {
        finish(found)
        return
      }

      const now = performance.now()
      const quiet = now - lastChange > QUIET_MS && !pageIsLoading()
      if (now - started > TARGET_TIMEOUT_MS || (quiet && found === null)) finish(null)
    }

    signal.addEventListener('abort', onAbort)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true })
    check()
  })
}

/** Whether the element rides in a fixed or sticky layer, which page scroll cannot move. */
function isPinned(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const { position } = getComputedStyle(node)
    if (position === 'fixed' || position === 'sticky') return true
  }
  return false
}

/**
 * Scrolls a target into the part of the viewport the card leaves free.
 *
 * Page content is centred in the band between the sticky top bar and a docked
 * sheet. Anything in a pinned layer -- the sidebar, the top bar, the tab bar --
 * is already on screen, and only its own scroller is asked to move.
 */
export function bringIntoView(element: HTMLElement, reserveBottom: number): void {
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches

  if (isPinned(element)) {
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    return
  }

  const rect = element.getBoundingClientRect()
  const top = TOP_INSET
  const bottom = window.innerHeight - reserveBottom - EDGE
  if (rect.top >= top && rect.bottom <= bottom) return

  const room = Math.max(0, bottom - top)
  const delta =
    rect.height >= room ? rect.top - top : rect.top - (top + (room - rect.height) / 2)

  window.scrollBy({ top: delta, behavior: smooth ? 'smooth' : 'auto' })
}

/**
 * The lit hole around a target, padded, with corners that follow its own: a
 * pill stays a pill and a card keeps its radius plus the padding.
 */
export function spotFor(element: HTMLElement): Spot {
  const rect = element.getBoundingClientRect()
  const radius = parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0
  const width = rect.width + SPOT_PADDING * 2
  const height = rect.height + SPOT_PADDING * 2
  const round = radius >= Math.min(rect.width, rect.height) / 2 - 1

  return {
    x: rect.left - SPOT_PADDING,
    y: rect.top - SPOT_PADDING,
    width,
    height,
    radius: round ? Math.min(width, height) / 2 : Math.max(radius + SPOT_PADDING, 10),
  }
}

/**
 * Where the card goes beside a spot.
 *
 * The preferred side if the card fits there, then right, bottom, left, top.
 * When no side has room the one with the most wins and the card is clamped to
 * the viewport, overlapping the target rather than leaving the screen.
 */
export function placeCard(
  spot: Box,
  card: { width: number; height: number },
  viewport: { width: number; height: number },
  preferred: TourPlacement = 'bottom',
): CardPlacement {
  const room: Record<TourPlacement, number> = {
    top: spot.y - CARD_GAP - EDGE,
    bottom: viewport.height - (spot.y + spot.height) - CARD_GAP - EDGE,
    left: spot.x - CARD_GAP - EDGE,
    right: viewport.width - (spot.x + spot.width) - CARD_GAP - EDGE,
  }
  const need = (side: TourPlacement): number =>
    side === 'top' || side === 'bottom' ? card.height : card.width

  const order = [preferred, ...FALLBACK_ORDER.filter((side) => side !== preferred)]
  const side =
    order.find((candidate) => room[candidate] >= need(candidate)) ??
    order.reduce((best, candidate) =>
      room[candidate] - need(candidate) > room[best] - need(best) ? candidate : best,
    )

  const maxX = viewport.width - EDGE - card.width
  const maxY = viewport.height - EDGE - card.height
  const vertical = side === 'top' || side === 'bottom'

  const x = vertical
    ? clamp(spot.x + spot.width / 2 - card.width / 2, EDGE, maxX)
    : clamp(side === 'right' ? spot.x + spot.width + CARD_GAP : spot.x - CARD_GAP - card.width, EDGE, maxX)
  const y = vertical
    ? clamp(side === 'bottom' ? spot.y + spot.height + CARD_GAP : spot.y - CARD_GAP - card.height, EDGE, maxY)
    : clamp(spot.y + spot.height / 2 - card.height / 2, EDGE, maxY)

  const arrow = vertical
    ? clamp(spot.x + spot.width / 2 - x, ARROW_INSET, card.width - ARROW_INSET)
    : clamp(spot.y + spot.height / 2 - y, ARROW_INSET, card.height - ARROW_INSET)

  return { x, y, side, arrow }
}

/**
 * Which edge a phone's sheet docks to: whichever hides less of the target,
 * and the bottom when neither hides any. So the tab bar and the Scribble
 * button get a sheet at the top, and so does the open Scribble panel, whose
 * question box is at its foot.
 *
 * A target taller than the space a sheet leaves -- a story's details -- is
 * covered either way, and keeps the sheet at the bottom so its heading stays
 * readable.
 */
export function sheetDock(spot: Box | null, sheetHeight: number, viewportHeight: number): 'top' | 'bottom' {
  if (spot === null) return 'bottom'
  const band = viewportHeight - sheetHeight
  if (spot.height > band) return 'bottom'

  const hiddenByBottom = Math.max(0, spot.y + spot.height - band)
  const hiddenByTop = Math.max(0, sheetHeight - spot.y)
  return hiddenByTop < hiddenByBottom ? 'top' : 'bottom'
}
