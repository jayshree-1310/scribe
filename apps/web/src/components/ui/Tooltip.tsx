import { useId, useState } from 'react'
import type { ReactNode } from 'react'

interface TooltipProps {
  label: string
  children: ReactNode
  placement?: 'top' | 'bottom'
}

/**
 * Hover/focus tooltip. The label is wired through `aria-describedby` so it is
 * available to screen readers, and it appears on keyboard focus too.
 */
export function Tooltip({ label, children, placement = 'top' }: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const id = useId()

  return (
    <span
      className="tooltip"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      <span aria-describedby={id}>{children}</span>
      <span
        className={`tooltip__bubble tooltip__bubble--${placement}`}
        id={id}
        role="tooltip"
        hidden={!visible}
      >
        {label}
      </span>
    </span>
  )
}
