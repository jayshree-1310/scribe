import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../../lib/auth'
import { useTheme } from '../../lib/theme'
import { Avatar } from '../ui/Avatar'
import { Button } from '../ui/Button'
import { DropdownMenu, MenuItem, MenuSeparator } from '../ui/DropdownMenu'
import { Icon } from '../ui/Icon'
import { Logo } from './Logo'
import { Tooltip } from '../ui/Tooltip'

interface TopBarProps {
  /** Opens the nav drawer on tablet and mobile. */
  onOpenNav: () => void
  title?: string
}

export function TopBar({ onOpenNav, title }: TopBarProps) {
  const { session, signOut } = useAuth()
  const { resolved, toggle } = useTheme()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')

  const user = session?.user

  function onSearch(event: React.FormEvent) {
    event.preventDefault()
    const term = query.trim()
    navigate(term ? `/discover?q=${encodeURIComponent(term)}` : '/discover')
  }

  return (
    <header className="topbar">
      <Button
        className="topbar__nav-toggle"
        variant="ghost"
        iconOnly
        aria-label="Open navigation"
        onClick={onOpenNav}
        startIcon={<Icon name="menu" size="1.25rem" />}
      />

      {/* The sidebar carries the full lockup from 64rem up; below that the
          header would otherwise show no branding at all. */}
      <Logo to="/home" size="sm" markOnly className="topbar__brand" />

      {title ? <h1 className="topbar__title">{title}</h1> : null}

      <form className="topbar__search" role="search" onSubmit={onSearch}>
        <label className="visually-hidden" htmlFor="global-search">
          Search stories, authors and clubs
        </label>
        <Icon name="search" size="1.05rem" />
        <input
          id="global-search"
          type="search"
          placeholder="Search stories, authors, clubs…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </form>

      <div className="topbar__actions">
        <Tooltip
          placement="bottom"
          label={resolved === 'dark' ? 'Switch to light' : 'Switch to dark'}
        >
          <Button
            variant="ghost"
            iconOnly
            aria-label={resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            onClick={toggle}
            startIcon={<Icon name={resolved === 'dark' ? 'sun' : 'moon'} size="1.15rem" />}
          />
        </Tooltip>

        <Tooltip placement="bottom" label="Notifications">
          <Button
            variant="ghost"
            iconOnly
            aria-label="Notifications, 3 unread"
            startIcon={<Icon name="bell" size="1.15rem" />}
            className="topbar__bell"
          />
        </Tooltip>

        {user ? (
          <DropdownMenu
            label="Account"
            trigger={(props) => (
              <button {...props} type="button" className="topbar__avatar-btn">
                <Avatar user={user} size="sm" />
                <span className="visually-hidden">Open account menu</span>
              </button>
            )}
          >
            <div className="dropdown__header">
              <p className="dropdown__name">{user.displayName}</p>
              <p className="dropdown__handle">@{user.username}</p>
            </div>
            <MenuSeparator />
            <MenuItem
              icon={<Icon name="user" size="1rem" />}
              onSelect={() => navigate(`/profile/${user.username}`)}
            >
              Profile
            </MenuItem>
            <MenuItem
              icon={<Icon name="pen" size="1rem" />}
              onSelect={() => navigate('/author')}
            >
              Author studio
            </MenuItem>
            <MenuItem
              icon={<Icon name="settings" size="1rem" />}
              onSelect={() => navigate('/settings')}
            >
              Settings
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={<Icon name="logout" size="1rem" />}
              tone="danger"
              onSelect={() => {
                signOut()
                navigate('/')
              }}
            >
              Sign out
            </MenuItem>
          </DropdownMenu>
        ) : (
          <Link className="btn btn--primary btn--sm" to="/login">
            Sign in
          </Link>
        )}
      </div>
    </header>
  )
}
