/**
 * Reporting data access.
 *
 * Talks to the real Scribe API through the shared fetch wrapper, so errors
 * arrive as `ApiError` with a message safe to show. Follows the shape of
 * `books-api.ts`.
 *
 * One function, because the reader's half of moderation is one endpoint. The
 * queue reads through `/api/moderation/...` and has no UI yet; when it gets
 * one, its calls belong here beside this.
 */

import { request } from '../lib/api-client'
import { readerHeaders } from './stories-api'
import type { ReportInput } from '../types/moderation'

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
