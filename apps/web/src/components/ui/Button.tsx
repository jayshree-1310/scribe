import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { cn } from '../../lib/cn'
import { Spinner } from './Spinner'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'subtle' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

interface CommonProps {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Shows a spinner and blocks further clicks while an action is in flight. */
  loading?: boolean
  /** Square, label-less button — `aria-label` becomes required. */
  iconOnly?: boolean
  fullWidth?: boolean
  startIcon?: ReactNode
  endIcon?: ReactNode
  children?: ReactNode
  className?: string
}

type ButtonProps = CommonProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | keyof CommonProps>

function classesFor({
  variant = 'secondary',
  size = 'md',
  iconOnly,
  fullWidth,
  loading,
  className,
}: CommonProps): string {
  return cn(
    'btn',
    `btn--${variant}`,
    `btn--${size}`,
    iconOnly && 'btn--icon',
    fullWidth && 'btn--full',
    loading && 'is-loading',
    className,
  )
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  iconOnly = false,
  fullWidth = false,
  startIcon,
  endIcon,
  disabled,
  type = 'button',
  children,
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={classesFor({ variant, size, iconOnly, fullWidth, loading, className })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <Spinner /> : startIcon}
      {iconOnly ? null : <span className="btn__label">{children}</span>}
      {!iconOnly && !loading ? endIcon : null}
    </button>
  )
}

interface ButtonLinkProps extends CommonProps {
  to: string
  'aria-label'?: string
  onClick?: () => void
}

/** A router link styled as a button — for navigation, not actions. */
export function ButtonLink({
  to,
  variant = 'secondary',
  size = 'md',
  iconOnly = false,
  fullWidth = false,
  startIcon,
  endIcon,
  children,
  className,
  ...rest
}: ButtonLinkProps) {
  return (
    <Link
      {...rest}
      to={to}
      className={classesFor({ variant, size, iconOnly, fullWidth, className })}
    >
      {startIcon}
      {iconOnly ? null : <span className="btn__label">{children}</span>}
      {endIcon}
    </Link>
  )
}
