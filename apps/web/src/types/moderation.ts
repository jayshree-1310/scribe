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

/* The queue -------------------------------------------------------------- */

export type ReportStatus = 'OPEN' | 'RESOLVED'

/**
 * What a moderator can do with a report.
 *
 * `DISMISS` is also the undo: applied to a report that suspended somebody, it
 * lifts the suspension. Lifting one without a report to hang it on is
 * `reinstateUser`.
 */
export type ReportAction = 'DISMISS' | 'HIDE' | 'SUSPEND'

/** The same four fields every other author summary in the app carries. */
export interface ModerationUser {
  id: string
  username: string
  displayName: string | null
  avatarUrl: string | null
}

export interface ReportedContent {
  type: ReportTarget
  id: string
  excerpt: string
  hidden: boolean
  author: ModerationUser
  /** Where to go and read it in context, as a web-app path. */
  href: string
}

export interface Report {
  id: string
  targetType: ReportTarget
  targetId: string
  reason: ReportReason
  details: string | null
  status: ReportStatus
  /** Null while open. */
  action: ReportAction | null
  /** The moderator's own note. Never shown to the reporter. */
  note: string | null
  reporter: ModerationUser
  resolvedBy: ModerationUser | null
  resolvedAt: string | null
  createdAt: string
  updatedAt: string
  /**
   * Null when the row this report names is gone. The report is kept either
   * way, so the queue has to be able to draw one with nothing behind it.
   */
  target: ReportedContent | null
}

export interface ReportPage {
  items: Report[]
  page: number
  limit: number
  total: number
  totalPages: number
  hasMore: boolean
}

/** What each target is called in the queue. */
export const TARGET_LABELS: Record<ReportTarget, string> = {
  COMMENT: 'Comment',
  CLUB_DISCUSSION: 'Club post',
  CHANNEL_POST: 'Channel post',
}

/** The reason labels again, keyed for the queue's one-line summaries. */
export const REASON_LABELS: Record<ReportReason, string> = {
  SPAM: 'Spam',
  HARASSMENT: 'Harassment',
  HATE: 'Hate speech',
  SEXUAL: 'Sexual content',
  VIOLENCE: 'Violence',
  SPOILER: 'Spoiler',
  OTHER: 'Other',
}

/**
 * What each action does, in the words the queue offers them in.
 *
 * Ordered least to most severe, and `SUSPEND` last, so the destructive one is
 * never the button next to the cursor after a misclick.
 */
export const REPORT_ACTIONS: {
  value: ReportAction
  label: string
  hint: string
}[] = [
  {
    value: 'DISMISS',
    label: 'Dismiss',
    hint: 'Nothing wrong with it. Also lifts a suspension this report imposed.',
  },
  {
    value: 'HIDE',
    label: 'Hide it',
    hint: 'Takes the content down and tells its author why.',
  },
  {
    value: 'SUSPEND',
    label: 'Hide and suspend',
    hint: 'Takes it down and stops the account writing anything more.',
  },
]
