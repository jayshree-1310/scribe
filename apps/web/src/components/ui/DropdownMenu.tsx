import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

interface DropdownMenuProps {
  /** Render prop for the trigger; receives the props it must spread. */
  trigger: (props: {
    'aria-expanded': boolean
    'aria-haspopup': 'menu'
    id: string
    onClick: () => void
  }) => ReactNode
  children: ReactNode
  align?: 'start' | 'end'
  /** Accessible name for the menu itself. */
  label: string
}

/**
 * Small menu popover. Closes on outside click, on Esc, and when a menu item is
 * activated; focus returns to the trigger so keyboard users don't lose place.
 */
export function DropdownMenu({
  trigger,
  children,
  align = 'end',
  label,
}: DropdownMenuProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerId = useId()

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
        onClick: () => setOpen((current) => !current),
      })}

      {open ? (
        <div
          className={cn('dropdown__menu', `dropdown__menu--${align}`)}
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
