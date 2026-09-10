import type { CSSProperties, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { cn } from '../../lib/cn'
import { genreChipStyle } from '../../lib/cover'
/**
 * A genre only needs a name and a hue to render, and either a slug or an id to
 * link by — Discover accepts both. Kept structural so mock genres (which carry
 * a slug) and API genres (which carry an id) both fit.
 */
interface ChipGenre {
  id?: string
  name: string
  hue: number
  slug?: string
}

interface GenreChipProps {
  genre: ChipGenre
  /** Renders as a link into Discover filtered by this genre. */
  asLink?: boolean
  size?: 'sm' | 'md'
}

export function GenreChip({ genre, asLink = false, size = 'sm' }: GenreChipProps) {
  const className = cn('chip', 'chip--genre', `chip--${size}`)
  const style = genreChipStyle(genre.hue) as CSSProperties

  if (asLink) {
    return (
      <Link
        className={className}
        style={style}
        to={`/discover?genre=${genre.slug ?? genre.id ?? ''}`}
      >
        {genre.name}
      </Link>
    )
  }

  return (
    <span className={className} style={style}>
      {genre.name}
    </span>
  )
}

interface SelectableChipProps {
  selected: boolean
  onToggle: () => void
  hue?: number
  children: ReactNode
}

/** Used by onboarding and Discover filters. */
export function SelectableChip({ selected, onToggle, hue, children }: SelectableChipProps) {
  return (
    <button
      type="button"
      className={cn('chip', 'chip--selectable', selected && 'is-selected')}
      style={hue === undefined ? undefined : ({ '--chip-hue': hue } as CSSProperties)}
      onClick={onToggle}
      aria-pressed={selected}
    >
      {children}
    </button>
  )
}

export type StatusTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'plum'

interface StatusBadgeProps {
  tone?: StatusTone
  children: ReactNode
  icon?: ReactNode
}

export function StatusBadge({ tone = 'neutral', children, icon }: StatusBadgeProps) {
  return (
    <span className={cn('status-badge', `status-badge--${tone}`)}>
      {icon}
      {children}
    </span>
  )
}
