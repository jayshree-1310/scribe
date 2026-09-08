import { useState } from 'react'
import { Link, NavLink } from 'react-router-dom'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { useAuth } from '../../lib/auth'
import { useTheme } from '../../lib/theme'
import { Button, ButtonLink } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Logo } from './Logo'
import './layout.css'

const PUBLIC_LINKS = [
  { to: '/discover', label: 'Discover' },
  { to: '/discover?sort=trending', label: 'Stories' },
  { to: '/clubs', label: 'Book Clubs' },
  { to: '/challenges', label: 'Writing Challenges' },
  { to: '/for-writers', label: 'For Writers' },
]

/** Header + footer chrome for the public marketing and auth pages. */
export function PublicShell({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const { session } = useAuth()
  const { resolved, toggle } = useTheme()

  return (
    <div className="public">
      <a className="shell__skip" href="#main">
        Skip to content
      </a>

      <header className={cn('public__header', menuOpen && 'is-open')}>
        <div className="public__header-inner container">
          <Logo to="/" />

          <nav className="public__nav" aria-label="Sections">
            {PUBLIC_LINKS.map((link) => (
              <NavLink
                key={link.label}
                to={link.to}
                className={({ isActive }) => cn('public__link', isActive && 'is-active')}
                onClick={() => setMenuOpen(false)}
              >
                {link.label}
              </NavLink>
            ))}
          </nav>

          <div className="public__actions">
            <Button
              variant="ghost"
              iconOnly
              aria-label={resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              onClick={toggle}
              startIcon={<Icon name={resolved === 'dark' ? 'sun' : 'moon'} size="1.15rem" />}
            />
            {session ? (
              <ButtonLink variant="primary" to="/home" endIcon={<Icon name="arrow-right" size="0.95em" />}>
                Your feed
              </ButtonLink>
            ) : (
              <>
                <ButtonLink variant="ghost" to="/login">
                  Login
                </ButtonLink>
                <ButtonLink variant="primary" to="/register">
                  Sign Up
                </ButtonLink>
              </>
            )}
            <Button
              className="public__menu-toggle"
              variant="ghost"
              iconOnly
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
              startIcon={<Icon name={menuOpen ? 'close' : 'menu'} size="1.25rem" />}
            />
          </div>
        </div>
      </header>

      <main id="main">{children}</main>

      <footer className="public__footer">
        <div className="container public__footer-inner">
          <div className="public__footer-brand">
            <Logo to="/" size="sm" />
            <p>
              A home for stories — read what you love, write what you can't stop
              thinking about, and find the people who feel the same.
            </p>
          </div>

          <nav className="public__footer-nav" aria-label="Footer">
            <div>
              <h3>Read</h3>
              <Link to="/discover">Discover</Link>
              <Link to="/clubs">Book clubs</Link>
              <Link to="/challenges">Challenges</Link>
            </div>
            <div>
              <h3>Write</h3>
              <Link to="/for-writers">For writers</Link>
              <Link to="/author">Author studio</Link>
              <Link to="/author/stories/new">Start a story</Link>
            </div>
            <div>
              <h3>Account</h3>
              <Link to="/login">Sign in</Link>
              <Link to="/register">Create account</Link>
              <Link to="/settings">Settings</Link>
            </div>
          </nav>
        </div>
        <div className="container public__footer-legal">
          <span>© 2026 Scribe</span>
          <span>Made for readers and the people who write for them.</span>
        </div>
      </footer>
    </div>
  )
}
