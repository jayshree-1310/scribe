/**
 * Splits an Ask This Book answer into prose and citation markers.
 *
 * The server normalises markers in the JSON reply, but the panel renders the
 * *streamed* reply, whose text reaches the browser before anything could
 * rewrite it — so the grammar is repeated here. Keep it in step with
 * `MARKER_GROUP` in `apps/api/src/services/ai/ask-book.ts`: `[2]`, `[1, 3]`,
 * and the fullwidth `【2】` / `【2†source】` some models write regardless of
 * what they were asked for.
 */

const MARKER_GROUP = /\s*[[【](\d{1,3}(?:\s*,\s*\d{1,3})*)(?:†[^\]】]*)?[\]】]/g

export type AnswerSegment =
  | { kind: 'text'; text: string }
  | { kind: 'cite'; markers: number[] }

/**
 * The answer as segments.
 *
 * `valid` is the set of markers the server returned citations for, once the
 * stream has ended. Until then it is null and every marker is shown as
 * written; after, markers that point at nothing are dropped, because a
 * citation that leads nowhere is worse than none.
 */
export function segmentAnswer(
  text: string,
  valid: ReadonlySet<number> | null,
): AnswerSegment[] {
  const segments: AnswerSegment[] = []
  let last = 0

  for (const match of text.matchAll(MARKER_GROUP)) {
    const start = match.index ?? 0
    if (start > last) segments.push({ kind: 'text', text: text.slice(last, start) })
    last = start + match[0].length

    const markers = (match[1] ?? '')
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((marker) => valid === null || valid.has(marker))
    if (markers.length > 0) segments.push({ kind: 'cite', markers })
  }

  if (last < text.length) segments.push({ kind: 'text', text: text.slice(last) })
  return segments
}
