import type { CSSProperties } from 'react'
import { cn } from '../../lib/cn'
import type { User } from '../../types/domain'

type AvatarUser = Pick<User, 'displayName' | 'avatarHue' | 'username'> & {
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
  return (
    <span
      className={cn('avatar', `avatar--${size}`, className)}
      style={{
        '--avatar-bg': `hsl(${user.avatarHue} 44% 32%)`,
        '--avatar-fg': `hsl(${user.avatarHue} 60% 92%)`,
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
