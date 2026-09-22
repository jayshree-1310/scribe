/**
 * Reporting data access.
 *
 * Talks to the real Scribe API through the shared fetch wrapper, so errors
 * arrive as `ApiError` with a message safe to show. Follows the shape of
 * `books-api.ts`.
 *
 * Two halves: what a reader files, and what a moderator does with it. The
 * second lot all answer 403 for anybody who is not an administrator, which the
 * queue page treats as "you should not be here" rather than as a failure.
 */

import { request } from '../lib/api-client'
import { readerHeaders } from './stories-api'
import type {
  ModerationUser,
  Report,
  ReportAction,
  ReportInput,
  ReportPage,
  ReportReason,
  ReportStatus,
  ReportTarget,
} from '../types/moderation'

/**
 * Files a report.
 *
 * Answers nothing the caller needs: the reader is told "thanks, we are looking
 * at it" either way, and showing them the report row would invite them to
 * watch a queue they cannot see. The response is discarded deliberately.
 *
 * Throws `ApiError` with status 409 when this reader already has an open
 * report on the same thing, which the dialog renders as its own message rather
 * than as a failure -- from the reader's side, already reported is the
 * outcome they wanted.
 */
export async function reportContent(input: ReportInput): Promise<void> {
  await request<{ report: unknown }>('/reports', {
    method: 'POST',
    headers: readerHeaders(),
    body: input,
  })
}

/* The queue -------------------------------------------------------------- */

export interface QueueFilters {
  /** `ALL` lists both; the API defaults to open. */
  status?: ReportStatus | 'ALL'
  targetType?: ReportTarget
  reason?: ReportReason
  page?: number
  limit?: number
}

export async function listReports(
  filters: QueueFilters = {},
): Promise<ReportPage> {
  return request<ReportPage>('/moderation/reports', {
    headers: readerHeaders(),
    query: {
      status: filters.status,
      targetType: filters.targetType,
      reason: filters.reason,
      page: filters.page === undefined ? undefined : String(filters.page),
      limit: filters.limit === undefined ? undefined : String(filters.limit),
    },
  })
}

/**
 * Acts on a report, and answers the row as it now stands.
 *
 * The resolved report rather than nothing, because the queue redraws the row
 * it just acted on -- its new status, and whether the target is now hidden --
 * and the request has already read everything that answer needs.
 */
export async function resolveReport(
  id: string,
  input: { action: ReportAction; note?: string },
): Promise<Report> {
  const { report } = await request<{ report: Report }>(
    `/moderation/reports/${encodeURIComponent(id)}/resolve`,
    { method: 'POST', headers: readerHeaders(), body: input },
  )

  return report
}

/**
 * Lifts a suspension on its own.
 *
 * Separate from `resolveReport` because a suspension can outlive the report
 * that imposed it -- delete the reporter's account and the report goes with
 * it -- and until this existed the only way back was a statement against the
 * database.
 */
export async function reinstateUser(userId: string): Promise<ModerationUser> {
  const { user } = await request<{ user: ModerationUser }>(
    `/moderation/users/${encodeURIComponent(userId)}/reinstate`,
    { method: 'POST', headers: readerHeaders() },
  )

  return user
}
