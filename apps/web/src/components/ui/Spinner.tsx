interface SpinnerProps {
  /** Accessible label; omit inside an element that already announces busy-ness. */
  label?: string
}

export function Spinner({ label }: SpinnerProps) {
  return (
    <span className="spinner" role={label ? 'status' : undefined}>
      <svg className="spinner__svg" viewBox="0 0 16 16" aria-hidden="true">
        <circle className="spinner__track" cx="8" cy="8" r="6.5" />
        <circle className="spinner__head" cx="8" cy="8" r="6.5" />
      </svg>
      {label ? <span className="visually-hidden">{label}</span> : null}
    </span>
  )
}
