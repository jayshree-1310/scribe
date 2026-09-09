import { Link } from 'react-router-dom'
import { cn } from '../../lib/cn'

interface LogoProps {
  to?: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
  /** Renders the mark alone, without the wordmark — for tight chrome. */
  markOnly?: boolean
  className?: string
}

/**
 * The Scribe mark: a bookmark, drawn as one solid shape.
 *
 * It is deliberately a single bold silhouette with no interior detail — the
 * mark has to survive a 16px favicon and a monochrome print, and thin strokes
 * or punched-out details turn to mush at that size. The bookmark also says
 * what Scribe is for (stories you keep and come back to) without resorting to
 * the open-book glyph every reading app already uses.
 */
export function ScribeMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="100%"
      height="100%"
      role="presentation"
      focusable="false"
    >
      <path
        fill="currentColor"
        d="M6.6 4.6A1.9 1.9 0 0 1 8.5 2.7h7A1.9 1.9 0 0 1 17.4 4.6v16.1c0 .9-1 1.4-1.7.9L12 18.7l-3.7 2.9c-.7.5-1.7 0-1.7-.9z"
      />
    </svg>
  )
}

/** Scribe lockup: the bookmark mark in a brand tile beside an editorial wordmark. */
export function Logo({ to = '/', size = 'md', markOnly = false, className }: LogoProps) {
  const content = (
    <>
      <span className="logo__mark" aria-hidden="true">
        <ScribeMark />
      </span>
      {markOnly ? (
        <span className="visually-hidden">Scribe</span>
      ) : (
        <span className="logo__word">Scribe</span>
      )}
    </>
  )

  const classes = cn('logo', `logo--${size}`, markOnly && 'logo--mark-only', className)

  return to ? (
    <Link className={classes} to={to} aria-label={markOnly ? 'Scribe' : undefined}>
      {content}
    </Link>
  ) : (
    <span className={classes}>{content}</span>
  )
}
