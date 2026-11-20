/**
 * Motion helpers shared by the page and theme transitions.
 *
 * Both read the motion tokens from `index.css` rather than restating them, so
 * the reduced-motion override there (`--dur*: 1ms`) applies here too.
 */

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/** A `--dur*` token in milliseconds, or the fallback if it cannot be read. */
export function motionToken(name: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) ? value : fallback
}

const THEME_FADE_CLASS = 'theme-fading'
let themeFadeTimer: number | undefined

/**
 * Runs `update` -- which must change the theme synchronously -- as a cross-fade
 * from the old palette to the new one instead of a one-frame flip.
 *
 * Where the View Transitions API exists, the browser snapshots the page, runs
 * the update, and cross-fades the two (styled in `index.css`). Elsewhere every
 * element's colours ease across for the length of the fade, which is close
 * enough. With reduced motion requested, the switch is simply instant.
 */
export function transitionTheme(update: () => void): void {
  if (prefersReducedMotion()) {
    update()
    return
  }

  if (typeof document.startViewTransition === 'function') {
    document.startViewTransition(update)
    return
  }

  const root = document.documentElement
  root.classList.add(THEME_FADE_CLASS)
  update()
  window.clearTimeout(themeFadeTimer)
  themeFadeTimer = window.setTimeout(
    () => root.classList.remove(THEME_FADE_CLASS),
    motionToken('--dur-theme', 360),
  )
}
