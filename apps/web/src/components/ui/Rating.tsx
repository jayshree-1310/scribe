import { useState } from 'react'
import { cn } from '../../lib/cn'
import { Icon } from './Icon'

interface StarsProps {
  value: number
  size?: string
  className?: string
}

/** Read-only star row, rounded to the nearest half. */
export function Stars({ value, size = '1em', className }: StarsProps) {
  const rounded = Math.round(value * 2) / 2

  return (
    <span className={cn('stars', className)} aria-hidden="true">
      {[1, 2, 3, 4, 5].map((position) => (
        <Icon
          key={position}
          size={size}
          name={
            rounded >= position
              ? 'star-filled'
              : rounded >= position - 0.5
                ? 'star-half'
                : 'star'
          }
        />
      ))}
    </span>
  )
}

interface RatingInputProps {
  value: number
  onChange: (value: number) => void
  /** Describes what is being rated, for screen readers. */
  label: string
  disabled?: boolean
}

/**
 * Interactive 1–5 rating. Implemented as a radio group so arrow keys work and
 * the current choice is announced.
 */
export function RatingInput({ value, onChange, label, disabled = false }: RatingInputProps) {
  const [hovered, setHovered] = useState(0)
  const shown = hovered || value

  return (
    <div
      className={cn('rating-input', disabled && 'is-disabled')}
      role="radiogroup"
      aria-label={label}
      onMouseLeave={() => setHovered(0)}
    >
      {[1, 2, 3, 4, 5].map((score) => (
        <button
          key={score}
          type="button"
          role="radio"
          aria-checked={value === score}
          aria-label={`${score} ${score === 1 ? 'star' : 'stars'}`}
          className={cn('rating-input__star', shown >= score && 'is-active')}
          disabled={disabled}
          onMouseEnter={() => setHovered(score)}
          onFocus={() => setHovered(score)}
          onBlur={() => setHovered(0)}
          onClick={() => onChange(score)}
        >
          <Icon name={shown >= score ? 'star-filled' : 'star'} size="1.5rem" />
        </button>
      ))}
    </div>
  )
}
