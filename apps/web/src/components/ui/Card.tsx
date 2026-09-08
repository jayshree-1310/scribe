import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { cn } from '../../lib/cn'
import { Icon, type IconName } from './Icon'

interface CardProps {
  children: ReactNode
  /** Adds hover lift; use only when the whole card is interactive. */
  interactive?: boolean
  padded?: boolean
  className?: string
  as?: 'div' | 'article' | 'section' | 'li'
  /** Anchor target, used by the in-page settings navigation. */
  id?: string
}

export function Card({
  children,
  interactive = false,
  padded = true,
  className,
  as: Tag = 'div',
  id,
}: CardProps) {
  return (
    <Tag
      id={id}
      className={cn(
        'card',
        interactive && 'card--interactive',
        padded && 'card--padded',
        className,
      )}
    >
      {children}
    </Tag>
  )
}

interface StatTileProps {
  label: string
  value: string
  /** Short supporting line, e.g. "+12% vs last week". */
  detail?: string
  icon?: IconName
  trend?: 'up' | 'down' | 'flat'
}

export function StatTile({ label, value, detail, icon, trend }: StatTileProps) {
  return (
    <div className="stat-tile">
      <div className="stat-tile__head">
        <span className="stat-tile__label">{label}</span>
        {icon ? (
          <span className="stat-tile__icon">
            <Icon name={icon} size="1rem" />
          </span>
        ) : null}
      </div>
      <p className="stat-tile__value">{value}</p>
      {detail ? (
        <p className={cn('stat-tile__detail', trend && `is-${trend}`)}>
          {trend === 'up' ? <Icon name="trend" size="0.9em" /> : null}
          {detail}
        </p>
      ) : null}
    </div>
  )
}

interface SectionHeadProps {
  title: string
  subtitle?: string
  /** Renders a "see all" link on the right. */
  to?: string
  linkLabel?: string
  action?: ReactNode
}

export function SectionHead({
  title,
  subtitle,
  to,
  linkLabel = 'See all',
  action,
}: SectionHeadProps) {
  return (
    <div className="section-head">
      <div>
        <h2 className="section-head__title">{title}</h2>
        {subtitle ? <p className="section-head__sub">{subtitle}</p> : null}
      </div>
      {action}
      {to ? (
        <Link className="section-head__link" to={to}>
          {linkLabel}
          <Icon name="chevron-right" size="0.85em" />
        </Link>
      ) : null}
    </div>
  )
}
