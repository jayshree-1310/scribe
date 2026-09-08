import { useId, useState } from 'react'
import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'
import { Icon } from './Icon'

interface CommonProps {
  label: string
  error?: string
  hint?: ReactNode
  /** Shows a "used / max" counter. Pair with `maxLength`. */
  counterMax?: number
  /** Visually hides the label while keeping it for assistive tech. */
  hideLabel?: boolean
  startIcon?: ReactNode
  value: string
}

type InputProps = CommonProps &
  Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'value'> & {
    multiline?: false
  }

type TextAreaProps = CommonProps &
  Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className' | 'value'> & {
    multiline: true
    rows?: number
  }

export function TextField(props: InputProps | TextAreaProps) {
  const { label, error, hint, counterMax, hideLabel, startIcon, value, ...rest } = props
  const generatedId = useId()
  const id = rest.id ?? generatedId
  const hintId = `${id}-hint`
  const errorId = `${id}-error`

  const describedBy = [error ? errorId : null, hint ? hintId : null]
    .filter(Boolean)
    .join(' ')

  const shared = {
    id,
    value,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy || undefined,
    className: 'field__control',
  }

  const overLimit = counterMax !== undefined && value.length > counterMax

  return (
    <div className={cn('field', error && 'has-error')}>
      <div className="field__head">
        <label className={cn('field__label', hideLabel && 'visually-hidden')} htmlFor={id}>
          {label}
        </label>
        {counterMax !== undefined ? (
          <span className={cn('field__counter', overLimit && 'is-over')} aria-hidden="true">
            {value.length.toLocaleString()} / {counterMax.toLocaleString()}
          </span>
        ) : null}
      </div>

      <div className={cn('field__wrap', Boolean(startIcon) && 'has-start-icon')}>
        {startIcon ? <span className="field__icon">{startIcon}</span> : null}
        {props.multiline ? (
          <textarea
            {...(rest as Omit<TextAreaProps, keyof CommonProps | 'multiline'>)}
            {...shared}
          />
        ) : (
          <input
            {...(rest as Omit<InputProps, keyof CommonProps | 'multiline'>)}
            {...shared}
          />
        )}
      </div>

      {hint && !error ? (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}

      {error ? (
        <p className="field__error" id={errorId}>
          <Icon name="alert" size="0.95em" />
          {error}
        </p>
      ) : null}
    </div>
  )
}

type PasswordFieldProps = Omit<InputProps, 'multiline' | 'type'> & {
  /** Rendered under the field — used for the strength meter on sign-up. */
  footer?: ReactNode
}

/** Password input with a show/hide toggle that keeps focus in the field. */
export function PasswordField({ footer, ...props }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false)

  return (
    <div className="password-field">
      <TextField {...props} type={visible ? 'text' : 'password'} />
      <button
        type="button"
        className="password-field__toggle"
        onClick={() => setVisible((current) => !current)}
        aria-pressed={visible}
        aria-label={visible ? 'Hide password' : 'Show password'}
      >
        <Icon name={visible ? 'eye-off' : 'eye'} />
      </button>
      {footer}
    </div>
  )
}
