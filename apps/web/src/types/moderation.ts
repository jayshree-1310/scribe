/**
 * Reporting types.
 *
 * These mirror the API responses in `apps/api/src/services/moderation.ts`
 * exactly, the same way `types/engagement.ts` mirrors the engagement service.
 *
 * Only the reader's half is modelled. The moderation queue -- `GET
 * /api/moderation/reports` and the resolve endpoint -- has no UI yet, so
 * putting its `Report` shape here would be a type nothing imports; it goes in
 * with the queue that reads it.
 */

/** The three kinds of user-written text that can be reported. */
export type ReportTarget = 'COMMENT' | 'CLUB_DISCUSSION' | 'CHANNEL_POST'

export type ReportReason =
  | 'SPAM'
  | 'HARASSMENT'
  | 'HATE'
  | 'SEXUAL'
  | 'VIOLENCE'
  | 'SPOILER'
  | 'OTHER'

/**
 * The reasons in the order the dialog offers them, with the wording a reader
 * sees. Ordered by how often each is the right answer rather than
 * alphabetically, so the common cases are not below the fold on a phone, and
 * `OTHER` is last because it is the one that asks for typing.
 */
export const REPORT_REASONS: { value: ReportReason; label: string; hint: string }[] =
  [
    {
      value: 'SPAM',
      label: 'Spam or advertising',
      hint: 'Selling something, or the same message posted everywhere.',
    },
    {
      value: 'HARASSMENT',
      label: 'Harassment or bullying',
      hint: 'Aimed at somebody, and meant to hurt.',
    },
    {
      value: 'HATE',
      label: 'Hate speech',
      hint: 'Attacks a group of people for who they are.',
    },
    {
      value: 'SEXUAL',
      label: 'Sexual content',
      hint: 'Explicit material where it does not belong.',
    },
    {
      value: 'VIOLENCE',
      label: 'Violence or threats',
      hint: 'Threatens somebody, or celebrates harm.',
    },
    {
      value: 'SPOILER',
      label: 'Unmarked spoiler',
      hint: 'Gives away a plot point without warning.',
    },
    {
      value: 'OTHER',
      label: 'Something else',
      hint: 'Tell us what is wrong with it below.',
    },
  ]

/** The longest `details` the API stores. */
export const REPORT_DETAILS_MAX_LENGTH = 1000

export interface ReportInput {
  targetType: ReportTarget
  targetId: string
  reason: ReportReason
  /** Free text; required by the dialog only for `OTHER`. */
  details?: string
}
