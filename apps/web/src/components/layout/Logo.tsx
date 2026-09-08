import { Link } from 'react-router-dom'
import { cn } from '../../lib/cn'

interface LogoProps {
  to?: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

/** Scribe wordmark: a quill-nib monogram beside an editorial serif wordmark. */
export function Logo({ to = '/', size = 'md', className }: LogoProps) {
  const content = (
    <>
      <span className="logo__mark" aria-hidden="true">
        <svg viewBox="0 0 28 28" width="100%" height="100%">
          <path
            d="M6 22c8-1.6 12.5-6.4 14.6-12.4M23.5 4C11 4 6 10.5 6 17.6c0 1.3.3 2.6.7 3.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
          <path d="M5.5 23.5h7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      </span>
      <span className="logo__word">Scribe</span>
    </>
  )

  const classes = cn('logo', `logo--${size}`, className)

  return to ? (
    <Link className={classes} to={to}>
      {content}
    </Link>
  ) : (
    <span className={classes}>{content}</span>
  )
}
