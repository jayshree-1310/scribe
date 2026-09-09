import { useEffect, useId, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { cn } from '../../lib/cn'

interface DropdownMenuProps {
  /** Render prop for the trigger; receives the props it must spread. */
  trigger: (props: {
    'aria-expanded': boolean
    'aria-haspopup': 'menu'
    id: string
    onClick: (event: MouseEvent<HTMLElement>) => void
  }) => ReactNode
  children: ReactNode
  align?: 'start' | 'end'
  /**
   * Preferred vertical side. The menu flips to the opposite side when the
   * preferred one cannot fit it on screen, so it is a preference, not a
   * guarantee.
   */
  side?: 'bottom' | 'top'
  /** Accessible name for the menu itself. */
  label: string
}

/**
 * Roughly how tall a menu gets. Used to decide which side to open on before
 * the menu exists to be measured — close enough for the choice, and cheaper
 * than rendering it offscreen first.
 */
const ESTIMATED_MENU_HEIGHT = 260

/**
 * Small menu popover. Closes on outside click, on Esc, and when a menu item is
 * activated; focus returns to the trigger so keyboard users don't lose place.
 */
export function DropdownMenu({
  trigger,
  children,
  align = 'end',
  side = 'bottom',
  label,
}: DropdownMenuProps) {
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState<'bottom' | 'top'>(side)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerId = useId()

  /**
   * Chooses the side to open on from where the trigger currently sits. Decided
   * here rather than after mounting so the menu never appears in one place and
   * jumps to another.
   */
  function toggle(event: MouseEvent<HTMLElement>): void {
    if (open) {
      setOpen(false)
      return
    }

    // Measured from the event's own target rather than a ref, so this reads
    // nothing during render and describes the trigger itself.
    const rect = event.currentTarget.getBoundingClientRect()
    const room = {
      bottom: window.innerHeight - rect.bottom,
      top: rect.top,
    }
    const opposite = side === 'bottom' ? 'top' : 'bottom'

    // Keep the caller's preference unless it cannot fit and the other side
    // genuinely has more room.
    setPlacement(
      room[side] < ESTIMATED_MENU_HEIGHT && room[opposite] > room[side]
        ? opposite
        : side,
    )
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return

    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      setOpen(false)
      containerRef.current?.querySelector<HTMLElement>(`#${CSS.escape(triggerId)}`)?.focus()
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, triggerId])

  return (
    <div className="dropdown" ref={containerRef}>
      {trigger({
        'aria-expanded': open,
        'aria-haspopup': 'menu',
        id: triggerId,
        onClick: toggle,
      })}

      {open ? (
        <div
          className={cn(
            'dropdown__menu',
            `dropdown__menu--${align}`,
            `dropdown__menu--${placement}`,
          )}
          role="menu"
          aria-label={label}
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      ) : null}
    </div>
  )
}

interface MenuItemProps {
  onSelect?: () => void
  icon?: ReactNode
  children: ReactNode
  tone?: 'default' | 'danger'
}

export function MenuItem({ onSelect, icon, children, tone = 'default' }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className={cn('dropdown__item', tone === 'danger' && 'is-danger')}
      onClick={onSelect}
    >
      {icon}
      <span>{children}</span>
    </button>
  )
}

export function MenuSeparator() {
  return <hr className="dropdown__separator" role="separator" />
}
