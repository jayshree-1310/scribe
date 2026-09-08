import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { useAuth } from '../../lib/auth'
import { Icon } from '../ui/Icon'
import { MobileNav } from './MobileNav'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { AUTHOR_NAV, READER_NAV } from './nav-config'
import './layout.css'

interface AppShellProps {
  children: ReactNode
  /** Chooses the reader navigation or the author studio navigation. */
  variant?: 'reader' | 'author'
  /** Constrains content for text-heavy pages. */
  width?: 'default' | 'narrow'
}

export function AppShell({ children, variant = 'reader', width = 'default' }: AppShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const { session } = useAuth()
  const location = useLocation()

  const sections = variant === 'author' ? AUTHOR_NAV : READER_NAV

  // Esc closes the drawer; route changes close it via each link's onClick.
  useEffect(() => {
    if (!drawerOpen) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setDrawerOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [drawerOpen])

  const modeSwitch =
    variant === 'author' ? (
      <Link className="mode-switch" to="/home">
        <Icon name="book-open" size="1.05rem" />
        <span>
          <strong>Reading</strong>
          Back to your feed
        </span>
      </Link>
    ) : (
      <Link className="mode-switch" to="/author">
        <Icon name="pen" size="1.05rem" />
        <span>
          <strong>Author studio</strong>
          {session?.user.isAuthor ? 'Manage your stories' : 'Start publishing'}
        </span>
      </Link>
    )

  return (
    <div className={cn('shell', drawerOpen && 'has-drawer-open')}>
      <a className="shell__skip" href="#main">
        Skip to content
      </a>

      <aside className="shell__sidebar">
        <Sidebar sections={sections} footer={modeSwitch} />
      </aside>

      {/* Drawer: same navigation for tablet and phone. */}
      <div
        className="shell__scrim"
        role="presentation"
        onClick={() => setDrawerOpen(false)}
      />
      <aside
        className="shell__drawer"
        aria-label="Navigation"
        aria-hidden={!drawerOpen}
        inert={drawerOpen ? undefined : true}
      >
        <Sidebar
          sections={sections}
          footer={modeSwitch}
          onNavigate={() => setDrawerOpen(false)}
        />
      </aside>

      <div className="shell__main">
        <TopBar onOpenNav={() => setDrawerOpen(true)} />
        <main className={cn('shell__content', `shell__content--${width}`)} id="main" key={location.pathname}>
          {children}
        </main>
      </div>

      <MobileNav sections={sections} onOpenMore={() => setDrawerOpen(true)} />
    </div>
  )
}
