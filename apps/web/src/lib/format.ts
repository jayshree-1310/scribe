/** Number, date and duration formatting used across the app. */

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
const decimal = new Intl.NumberFormat('en')
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
const shortDate = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' })
const monthDay = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' })

/** 1200 → "1.2K". Used wherever counts sit inside a card. */
export function formatCount(value: number): string {
  return compact.format(value)
}

export function formatNumber(value: number): string {
  return decimal.format(value)
}

export function formatRating(value: number): string {
  return value.toFixed(2)
}

const DIVISIONS: Array<{ amount: number; unit: Intl.RelativeTimeFormatUnit }> = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.34524, unit: 'week' },
  { amount: 12, unit: 'month' },
  { amount: Number.POSITIVE_INFINITY, unit: 'year' },
]

export function formatRelative(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''

  let duration = (date.getTime() - Date.now()) / 1000
  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return relative.format(Math.round(duration), division.unit)
    }
    duration /= division.amount
  }
  return shortDate.format(date)
}

export function formatDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : shortDate.format(date)
}

export function formatMonthDay(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : monthDay.format(date)
}

/** "3h 20m" / "45m" — for reading time and challenge countdowns. */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`
  const hours = Math.floor(minutes / 60)
  const rest = Math.round(minutes % 60)
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes}:${rest.toString().padStart(2, '0')}`
}

/** Whole days between now and an ISO date; negative once past. */
export function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000)
}

export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`
}

/** Reading-time estimate from a word count, at 220wpm. */
export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / 220))
}
