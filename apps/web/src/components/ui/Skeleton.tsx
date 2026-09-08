interface SkeletonProps {
  width?: string
  height?: string
  radius?: string
  className?: string
}

export function Skeleton({
  width = '100%',
  height = '0.75rem',
  radius = 'var(--radius-sm)',
  className,
}: SkeletonProps) {
  return (
    <span
      className={className ? `skeleton ${className}` : 'skeleton'}
      style={{ width, height, borderRadius: radius }}
      aria-hidden="true"
    />
  )
}
