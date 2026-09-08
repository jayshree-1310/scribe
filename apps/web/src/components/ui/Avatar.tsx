import type { CSSProperties } from 'react'
import { cn } from '../../lib/cn'
import type { User } from '../../types/domain'

interface AvatarProps {
  user: Pick<User, 'displayName' | 'avatarHue' | 'username'>
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  className?: string
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2)
  return parts.map((part) => part[0]?.toUpperCase() ?? '').join('')
}

/**
 * Monogram avatar generated from the user's own hue — no uploaded images
 * exist yet, and a coloured monogram reads better than a generic silhouette.
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
    </span>
  )
}
