import { useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { useLocation } from 'react-router-dom'
import { motionToken, prefersReducedMotion } from '../lib/motion'

/**
 * Plays the `page-in` entrance on `ref` each time the path changes.
 *
 * The app shell's `<main>` persists across navigations (see `ShellLayout`), so
 * its CSS `page-in` animation only runs on first load, and every later page
 * simply replaced the last in one frame. Keying `<main>` on the path would
 * replay it, but would also remount the page on a param change and was the
 * source of the old flicker. Instead this replays the same keyframes with the
 * Web Animations API: nothing remounts, and the new page eases in.
 *
 * Runs in a layout effect so the first painted frame of the new page is
 * already the animation's first frame. Only the path counts -- a filter or
 * tab kept in the query string is the same page and should not re-enter.
 */
export function usePageTransition(ref: RefObject<HTMLElement | null>): void {
  const { pathname } = useLocation()
  const previous = useRef(pathname)

  useLayoutEffect(() => {
    if (previous.current === pathname) return
    previous.current = pathname

    const element = ref.current
    if (!element || typeof element.animate !== 'function') return

    // A quick second navigation restarts the entrance rather than stacking.
    for (const animation of element.getAnimations()) animation.cancel()

    const reduced = prefersReducedMotion()
    element.animate(
      reduced
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [
            { opacity: 0, transform: 'translateY(6px)' },
            { opacity: 1, transform: 'none' },
          ],
      {
        duration: reduced ? 1 : motionToken('--dur-slow', 280),
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)', // --ease-out
      },
    )
  }, [pathname, ref])
}
