/**
 * Converting between `<input type="datetime-local">` and the API's ISO times.
 *
 * The input yields `2026-04-01T09:00` -- no zone at all -- while the API's
 * schemas demand an offset. Reading that string with `new Date` interprets it
 * in the browser's zone, which is what a person means when they type a time:
 * their own clock. Shared by every form that takes one (hosting a challenge,
 * scheduling a chapter), so they cannot drift into two readings of a clock.
 */

/** ISO with an offset, from what a `datetime-local` input gives. */
export function localInputToIso(local: string): string {
  return new Date(local).toISOString()
}

/** And back, because the input cannot parse what `localInputToIso` produced. */
export function isoToLocalInput(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''

  // Not `toISOString().slice(...)`: that would shift the value back to UTC and
  // show a different clock from the one that was typed into.
  const pad = (value: number) => String(value).padStart(2, '0')

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}
