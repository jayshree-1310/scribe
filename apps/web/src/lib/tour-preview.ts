/**
 * Marks the requests the product tour causes, so the API does not count them.
 *
 * The tour opens a story and one of its chapters to show those pages off, and
 * the API records a view for the one and a read for the other. Neither is the
 * reader reading: counted, a brand-new account would start with a chapter it
 * never chose on its reader level and badges, and some author's analytics
 * would gain a reader who was only being shown around. See
 * `TOUR_PREVIEW_HEADER` in `apps/api/src/routes/stories.ts`.
 *
 * Module state rather than context because the data layer is not React.
 * `TourProvider` is the only writer.
 */

let previewing = false

export function setTourPreview(on: boolean): void {
  previewing = on
}

/** Spread into the headers of a request that records a visit. */
export function tourPreviewHeaders(): Record<string, string> {
  return previewing ? { 'X-Scribe-Tour': '1' } : {}
}
