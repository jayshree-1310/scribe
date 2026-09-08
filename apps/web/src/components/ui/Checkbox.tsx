import { useId } from 'react'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { Icon } from './Icon'

interface CheckboxProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  hint?: ReactNode
  error?: string
  disabled?: boolean
}

export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  error,
  disabled = false,
}: CheckboxProps) {
  const id = useId()
  const errorId = `${id}-error`

  return (
    <div className={cn('checkbox', error && 'has-error')}>
      <div className="checkbox__row">
        <input
          className="checkbox__input"
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-describedby={error ? errorId : undefined}
          aria-invalid={error ? true : undefined}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="checkbox__box" aria-hidden="true">
          <Icon name="check" size="0.8rem" strokeWidth={2.6} />
        </span>
        <label className="checkbox__label" htmlFor={id}>
          {label}
        </label>
      </div>
      {hint ? <p className="checkbox__hint">{hint}</p> : null}
      {error ? (
        <p className="checkbox__error" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  )
}

interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  description?: string
}

/** Labelled toggle used throughout Settings. */
export function Switch({ checked, onChange, label, description }: SwitchProps) {
  const id = useId()

  return (
    <div className="switch-row">
      <span className="switch-row__text">
        <label className="switch-row__label" htmlFor={id}>
          {label}
        </label>
        {description ? <span className="switch-row__desc">{description}</span> : null}
      </span>
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={checked}
        className={cn('switch', checked && 'is-on')}
        onClick={() => onChange(!checked)}
      >
        <span className="switch__thumb" />
      </button>
    </div>
  )
}
