import { NavLink } from 'react-router-dom'
import { cn } from '../../lib/cn'
import { Icon } from '../ui/Icon'
import { primaryItems, type NavSection } from './nav-config'

interface MobileNavProps {
  sections: NavSection[]
  onOpenMore: () => void
}

/**
 * Bottom tab bar for phones. Four destinations plus "More", which opens the
 * same drawer the tablet layout uses — so nothing is unreachable on mobile.
 */
export function MobileNav({ sections, onOpenMore }: MobileNavProps) {
  const items = primaryItems(sections).slice(0, 4)

  return (
    <nav className="mobile-nav" aria-label="Primary">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/author'}
          className={({ isActive }) => cn('mobile-nav__link', isActive && 'is-active')}
        >
          <Icon name={item.icon} size="1.3rem" />
          <span>{item.label}</span>
        </NavLink>
      ))}

      <button type="button" className="mobile-nav__link" onClick={onOpenMore}>
        <Icon name="menu" size="1.3rem" />
        <span>More</span>
      </button>
    </nav>
  )
}
