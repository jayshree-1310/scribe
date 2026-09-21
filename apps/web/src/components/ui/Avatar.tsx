import type { CSSProperties } from 'react'
import { cn } from '../../lib/cn'
import { hueFor } from '../../lib/cover'

/**
 * Structural rather than one of the API's user shapes, because every one of
 * them fits it: an `AccountProfile`, a `ProfileUser`, a comment's author
 * summary and a club member all carry these three fields under these names.
 *
 * There used to be an optional `avatarHue` here as well, supplied only by the
 * mock profile. `auth.User` has no such column and never had one, so the hue
 * is derived from the username -- which is what every API-sourced avatar was
 * already doing, and is now what all of them do.
 */
type AvatarUser = {
  username: string
  displayName?: string | null
  avatarUrl?: string | null
}

interface AvatarProps {
  user: AvatarUser
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  className?: string
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2)
  return parts.map((part) => part[0]?.toUpperCase() ?? '').join('')
}

/**
 * The reader's uploaded picture when there is one, and otherwise a monogram
 * generated from their own hue — which reads better than a generic silhouette.
 *
 * The monogram stays behind the image rather than being replaced by it, so a
 * picture that fails to load (deleted file, offline) degrades to the monogram
 * instead of a broken-image icon.
 */
export function Avatar({ user, size = 'md', className }: AvatarProps) {
  const hue = hueFor(user.username)

  return (
    <span
      className={cn('avatar', `avatar--${size}`, className)}
      style={{
        '--avatar-bg': `hsl(${hue} 44% 32%)`,
        '--avatar-fg': `hsl(${hue} 60% 92%)`,
      } as CSSProperties}
      aria-hidden="true"
    >
      {initials(user.displayName || user.username)}
      {user.avatarUrl ? (
        <img className="avatar__image" src={user.avatarUrl} alt="" />
      ) : null}
    </span>
  )
}
