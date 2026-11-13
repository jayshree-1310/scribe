import { Outlet, useMatches } from 'react-router-dom'
import { useAuth } from '../../lib/auth'
import { RequireAuth } from '../RequireAuth'
import { AppShell } from './AppShell'
import { PublicShell } from './PublicShell'

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
  /** Open to signed-out visitors; see `ReaderShellLayout`. */
  public?: boolean
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

/**
 * The reader's shell group, behind the sign-in gate -- except for a route
 * whose `handle` says `public: true` (a story's page), which a signed-out
 * visitor with a link may open. They get the public header and footer rather
 * than the app shell, whose navigation leads only to pages they cannot open.
 *
 * One layout for the whole group rather than a second group for the public
 * route, so a signed-in reader moving between a story and anything else keeps
 * the same mounted shell (see above).
 */
export function ReaderShellLayout() {
  const { session } = useAuth()
  const matches = useMatches()
  const isPublic = matches.some((match) => (match.handle as ShellHandle | undefined)?.public === true)

  if (!session && isPublic) {
    return (
      <PublicShell>
        {/* The app shell's own content frame, so the page lays out exactly
            as it does signed in: same width, same gutters. */}
        <div className="shell__content">
          <Outlet />
        </div>
      </PublicShell>
    )
  }

  return (
    <RequireAuth>
      <ShellLayout />
    </RequireAuth>
  )
}

export function ShellLayout({ variant = 'reader' }: ShellLayoutProps) {
  const matches = useMatches()

  return (
    <AppShell variant={variant} width={widthFrom(matches)}>
      <Outlet />
    </AppShell>
  )
}
