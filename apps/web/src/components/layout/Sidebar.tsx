import { NavLink } from 'react-router-dom'
import { cn } from '../../lib/cn'
import { Icon } from '../ui/Icon'
import { Logo } from './Logo'
import type { NavSection } from './nav-config'

interface SidebarProps {
  sections: NavSection[]
  /** Footer slot — the reader/author mode switch. */
  footer?: React.ReactNode
  onNavigate?: () => void
}

export function Sidebar({ sections, footer, onNavigate }: SidebarProps) {
  return (
    <div className="sidebar">
      <div className="sidebar__brand">
        <Logo to="/home" />
      </div>

      <nav className="sidebar__nav" aria-label="Main">
        {sections.map((section) => (
          <div className="sidebar__section" key={section.id}>
            {section.label ? (
              <p className="sidebar__section-label">{section.label}</p>
            ) : null}
            <ul>
              {section.items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.to === '/author'}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cn('sidebar__link', isActive && 'is-active')
                    }
                  >
                    <Icon name={item.icon} size="1.15rem" />
                    <span>{item.label}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      {footer ? <div className="sidebar__footer">{footer}</div> : null}
    </div>
  )
}
