import { cn } from '../../lib/cn'
import type { ReactNode } from 'react'

export interface TabItem<T extends string> {
  id: T
  label: string
  count?: number
  icon?: ReactNode
}

interface TabsProps<T extends string> {
  items: ReadonlyArray<TabItem<T>>
  active: T
  onChange: (id: T) => void
  /** Describes the tab set for assistive tech. */
  label: string
  variant?: 'underline' | 'pill'
}

/**
 * Tablist with roving focus. Arrow keys move between tabs, matching the
 * expected behaviour for `role="tablist"`.
 */
export function Tabs<T extends string>({
  items,
  active,
  onChange,
  label,
  variant = 'underline',
}: TabsProps<T>) {
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (direction === 0) return

    event.preventDefault()
    const index = items.findIndex((item) => item.id === active)
    const next = items[(index + direction + items.length) % items.length]
    if (next) onChange(next.id)
  }

  return (
    <div
      className={cn('tabs', `tabs--${variant}`)}
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => {
        const selected = item.id === active
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`tab-${item.id}`}
            aria-selected={selected}
            aria-controls={`panel-${item.id}`}
            tabIndex={selected ? 0 : -1}
            className={cn('tabs__tab', selected && 'is-active')}
            onClick={() => onChange(item.id)}
          >
            {item.icon}
            {item.label}
            {item.count === undefined ? null : (
              <span className="tabs__count">{item.count}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

interface TabPanelProps<T extends string> {
  id: T
  children: ReactNode
}

export function TabPanel<T extends string>({ id, children }: TabPanelProps<T>) {
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} tabIndex={-1}>
      {children}
    </div>
  )
}

interface SegmentedProps<T extends string> {
  items: ReadonlyArray<{ value: T; label: string; icon?: ReactNode }>
  value: T
  onChange: (value: T) => void
  label: string
  size?: 'sm' | 'md'
}

/** Compact single-choice control — theme pickers, reader settings. */
export function SegmentedControl<T extends string>({
  items,
  value,
  onChange,
  label,
  size = 'md',
}: SegmentedProps<T>) {
  return (
    <div
      className={cn('segmented', `segmented--${size}`)}
      role="radiogroup"
      aria-label={label}
    >
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="radio"
          aria-checked={item.value === value}
          className={cn('segmented__option', item.value === value && 'is-active')}
          onClick={() => onChange(item.value)}
        >
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  )
}
