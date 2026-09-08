import { cn } from '../../lib/cn'

interface ProgressBarProps {
  /** 0–1. */
  value: number
  label?: string
  size?: 'sm' | 'md'
  tone?: 'brand' | 'success'
  className?: string
}

export function ProgressBar({
  value,
  label,
  size = 'sm',
  tone = 'brand',
  className,
}: ProgressBarProps) {
  const percent = Math.max(0, Math.min(1, value)) * 100

  return (
    <div
      className={cn('progress', `progress--${size}`, `progress--${tone}`, className)}
      role="progressbar"
      aria-valuenow={Math.round(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <span className="progress__fill" style={{ width: `${percent}%` }} />
    </div>
  )
}
