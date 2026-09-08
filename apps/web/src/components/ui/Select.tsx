import { useId } from 'react'
import { cn } from '../../lib/cn'
import { Icon } from './Icon'

interface SelectOption<T extends string> {
  value: T
  label: string
}

interface SelectProps<T extends string> {
  label: string
  value: T
  options: ReadonlyArray<SelectOption<T>>
  onChange: (value: T) => void
  hideLabel?: boolean
  size?: 'sm' | 'md'
  disabled?: boolean
}

/** Native select — accessible everywhere and correct on mobile by default. */
export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  hideLabel = false,
  size = 'md',
  disabled = false,
}: SelectProps<T>) {
  const id = useId()

  return (
    <div className={cn('select', `select--${size}`)}>
      <label className={cn('select__label', hideLabel && 'visually-hidden')} htmlFor={id}>
        {label}
      </label>
      <div className="select__wrap">
        <select
          className="select__control"
          id={id}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value as T)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <Icon name="chevron-down" size="0.95em" />
      </div>
    </div>
  )
}
