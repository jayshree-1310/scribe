import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { Button } from './Button'
import { Icon, type IconName } from './Icon'

interface EmptyStateProps {
  icon?: IconName
  title: string
  description?: string
  action?: ReactNode
  tone?: 'neutral' | 'danger'
  size?: 'sm' | 'md'
}

export function EmptyState({
  icon = 'book',
  title,
  description,
  action,
  tone = 'neutral',
  size = 'md',
}: EmptyStateProps) {
  return (
    <div className={cn('empty', `empty--${tone}`, `empty--${size}`)}>
      <span className="empty__icon">
        <Icon name={icon} size="1.6rem" strokeWidth={1.5} />
      </span>
      <h3 className="empty__title">{title}</h3>
      {description ? <p className="empty__desc">{description}</p> : null}
      {action ? <div className="empty__action">{action}</div> : null}
    </div>
  )
}

interface ErrorStateProps {
  title?: string
  message?: string | null
  onRetry?: () => void
}

/** Standard failure panel for a section that could not load. */
export function ErrorState({
  title = "That didn't load",
  message,
  onRetry,
}: ErrorStateProps) {
  return (
    <EmptyState
      icon="alert"
      tone="danger"
      title={title}
      description={message ?? 'Something went wrong on our end. Please try again.'}
      action={
        onRetry ? (
          <Button variant="primary" onClick={onRetry} startIcon={<Icon name="retry" />}>
            Try again
          </Button>
        ) : undefined
      }
    />
  )
}

interface InlineNoticeProps {
  tone?: 'info' | 'danger' | 'success'
  children: ReactNode
  icon?: IconName
}

/** Non-blocking message shown above content (e.g. a failed refresh). */
export function InlineNotice({ tone = 'info', children, icon }: InlineNoticeProps) {
  return (
    <p className={cn('notice', `notice--${tone}`)} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon name={icon ?? (tone === 'danger' ? 'alert' : 'info')} size="1em" />
      <span>{children}</span>
    </p>
  )
}
