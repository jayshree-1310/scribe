import { Outlet, useMatches } from 'react-router-dom'
import { AppShell } from './AppShell'

/**
 * The shell, mounted once per group of routes rather than once per page.
 *
 * Every signed-in page used to render its own `<AppShell>`. React sees a
 * different component type at that position on each navigation, so the whole
 * shell -- sidebar, top bar, bell, Scribble widget -- was torn down and rebuilt
 * every time somebody followed a link, and `<main>` was keyed on the path to
 * replay its entry animation on top of that. Navigation flickered because it
 * was, quite literally, rebuilding the application each time.
 *
 * Here the shell is a layout route: it persists, and only `<Outlet />` changes.
 * Two consequences worth knowing. The `page-in` animation on `.shell__content`
 * now runs once, on first load, because the element it is attached to no longer
 * remounts -- which is what it always should have meant. And the Scribble
 * widget's conversation genuinely does survive navigation now; the comment in
 * `AppShell` claiming it did was true of the widget's position in the tree and
 * false in practice.
 */

/** What a route may say about how it wants to be framed. */
interface ShellHandle {
  width?: 'default' | 'narrow'
}

/**
 * The innermost route that expressed a preference wins, so a nested route can
 * narrow itself without the group having to know about it.
 */
function widthFrom(matches: ReturnType<typeof useMatches>): 'default' | 'narrow' {
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const handle = matches[index]?.handle as ShellHandle | undefined
    if (handle?.width) return handle.width
  }

  return 'default'
}

interface ShellLayoutProps {
  /** Chooses the reader navigation or the author studio navigation. */
  variant?: 'reader' | 'author'
}

export function ShellLayout({ variant = 'reader' }: ShellLayoutProps) {
  const matches = useMatches()

  return (
    <AppShell variant={variant} width={widthFrom(matches)}>
      <Outlet />
    </AppShell>
  )
}
