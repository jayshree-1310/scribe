import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useToast } from '../lib/toast'
import { ApiError } from '../lib/api-client'
import { formatRelative } from '../lib/format'
import * as moderationApi from '../data/moderation-api'
import { Avatar } from '../components/ui/Avatar'
import { Button } from '../components/ui/Button'
import { Dialog } from '../components/ui/Dialog'
import { EmptyState, ErrorState } from '../components/ui/States'
import { Icon } from '../components/ui/Icon'
import { Skeleton } from '../components/ui/Skeleton'
import { SegmentedControl } from '../components/ui/Tabs'
import { TextField } from '../components/ui/TextField'
import { useAsync } from '../hooks/useAsync'
import {
  REASON_LABELS,
  REPORT_ACTIONS,
  TARGET_LABELS,
} from '../types/moderation'
import type { Report, ReportAction } from '../types/moderation'
import './moderation-queue.css'

/**
 * The moderation queue: the first time these endpoints are read by a person.
 *
 * `GET /api/moderation/reports` and the resolve endpoint have been covered by
 * tests and reachable with a token since Task 15, which meant the filters, the
 * target excerpts and the "content no longer exists" case had only ever been
 * exercised by assertions. This is the surface that exercises them.
 *
 * **It is not an access control.** The page is offered when the session says
 * `isAdmin`, and every request it makes is checked again by `assertAdmin` on
 * the server -- so a browser that lied about the flag would see an empty queue
 * and a 403, which is what the "not for you" state below renders. The flag
 * decides what is *offered*; the API decides what is allowed.
 *
 * One page rather than a console with sections, deliberately. There is one
 * queue and three things to do with a row, and the rest of what an admin
 * console would grow -- user search, audit history, bulk actions -- are
 * features nobody has asked for yet rather than parts of this one.
 */

/** Enough to fill a screen without making a busy queue feel endless. */
const PAGE_SIZE = 20

type StatusFilter = 'OPEN' | 'RESOLVED' | 'ALL'

const STATUS_FILTERS = [
  { value: 'OPEN', label: 'Open' },
  { value: 'RESOLVED', label: 'Resolved' },
  { value: 'ALL', label: 'All' },
] as const satisfies ReadonlyArray<{ value: StatusFilter; label: string }>

export function ModerationQueuePage() {
  const { session } = useAuth()
  const { showToast } = useToast()

  const [status, setStatus] = useState<StatusFilter>('OPEN')
  const [page, setPage] = useState(1)
  /** Bumped after a resolution, to re-read the page it changed. */
  const [revision, setRevision] = useState(0)

  const isAdmin = session?.user.isAdmin === true

  const reports = useAsync(
    () =>
      isAdmin
        ? moderationApi.listReports({ status, page, limit: PAGE_SIZE })
        : Promise.resolve(null),
    [isAdmin, status, page, revision],
  )

  const [acting, setActing] = useState<Report | null>(null)

  /**
   * Offered only to somebody the session says is an administrator. The server
   * would refuse anyway; this is so a reader who lands here by typing the URL
   * gets an explanation rather than a wall of failed requests.
   */
  if (!isAdmin) {
    return (
      <EmptyState
        icon="shield"
        title="Not your queue"
        description="The moderation queue is for administrators. If you think it should be yours, somebody with database access has to say so."
        action={<Link to="/home">Back to your feed</Link>}
      />
    )
  }

  function onResolved(updated: Report): void {
    setActing(null)
    showToast({
      tone: 'success',
      message:
        updated.action === 'DISMISS'
          ? 'Dismissed.'
          : updated.action === 'SUSPEND'
            ? 'Hidden, and the account suspended.'
            : 'Hidden.',
    })
    // Re-read rather than patching the row in place: resolving sweeps *every*
    // open report on the same target, so one action can change rows this page
    // is showing that it did not act on.
    setRevision((current) => current + 1)
  }

  const items = reports.data?.items ?? []

  return (
    <>
      <header className="queue__head">
        <div>
          <h1 className="queue__title">Moderation</h1>
          <p className="queue__sub">
            {reports.status === 'ready' && reports.data
              ? `${reports.data.total} ${
                  status === 'OPEN' ? 'open' : status === 'RESOLVED' ? 'resolved' : ''
                } ${reports.data.total === 1 ? 'report' : 'reports'}`.replace(
                  /\s+/g,
                  ' ',
                )
              : 'Reports readers have filed.'}
          </p>
        </div>

        <SegmentedControl
          items={STATUS_FILTERS}
          value={status}
          onChange={(next) => {
            setStatus(next)
            setPage(1)
          }}
          label="Filter reports"
          size="sm"
        />
      </header>

      {/* Status first: an empty queue and a queue that failed to load are
          very different things to tell a moderator. */}
      {reports.status === 'loading' ? (
        <div className="queue__list" aria-busy="true">
          {[0, 1, 2].map((slot) => (
            <Skeleton key={slot} height="9rem" radius="var(--radius-lg)" />
          ))}
        </div>
      ) : reports.status === 'error' ? (
        <ErrorState
          title="We couldn't load the queue"
          message={reports.error}
          onRetry={reports.reload}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon="shield"
          title={status === 'OPEN' ? 'Nothing waiting' : 'Nothing here'}
          description={
            status === 'OPEN'
              ? 'No open reports. Readers can report a comment, a club post or a channel post from its overflow menu.'
              : 'No reports match this filter.'
          }
        />
      ) : (
        <>
          <ul className="queue__list">
            {items.map((report) => (
              <li key={report.id}>
                <ReportRow report={report} onAct={() => setActing(report)} />
              </li>
            ))}
          </ul>

          {(reports.data?.totalPages ?? 1) > 1 ? (
            <nav className="queue__pages" aria-label="Queue pages">
              <Button
                variant="ghost"
                disabled={page <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                startIcon={<Icon name="chevron-left" />}
              >
                Newer
              </Button>
              <span className="queue__page-of">
                Page {reports.data?.page} of {reports.data?.totalPages}
              </span>
              <Button
                variant="ghost"
                disabled={!reports.data?.hasMore}
                onClick={() => setPage((current) => current + 1)}
                startIcon={<Icon name="chevron-right" />}
              >
                Older
              </Button>
            </nav>
          ) : null}
        </>
      )}

      {acting ? (
        <ResolveDialog
          report={acting}
          onClose={() => setActing(null)}
          onResolved={onResolved}
        />
      ) : null}
    </>
  )
}

/* One row ---------------------------------------------------------------- */

function ReportRow({ report, onAct }: { report: Report; onAct: () => void }) {
  const open = report.status === 'OPEN'

  return (
    <article className={open ? 'report-row' : 'report-row is-resolved'}>
      <div className="report-row__head">
        <span className="report-row__badges">
          <span className="report-row__badge">
            {TARGET_LABELS[report.targetType]}
          </span>
          <span className="report-row__badge report-row__badge--reason">
            {REASON_LABELS[report.reason]}
          </span>
          {report.target?.hidden ? (
            <span className="report-row__badge report-row__badge--hidden">
              Hidden
            </span>
          ) : null}
        </span>

        <span className="report-row__when">
          {formatRelative(report.createdAt)}
        </span>
      </div>

      {/*
        The target, or the fact that there is not one. A report outlives the
        content it names -- the author can delete it, or it can go with the
        story it was on -- and the queue keeps the row either way, so "no
        longer exists" is a state this has to draw rather than a bug.
      */}
      {report.target ? (
        <div className="report-row__target">
          <Avatar user={report.target.author} size="sm" />
          <div className="report-row__target-body">
            <Link to={report.target.href} className="report-row__author">
              @{report.target.author.username}
            </Link>
            <p className="report-row__excerpt">{report.target.excerpt}</p>
          </div>
        </div>
      ) : (
        <p className="report-row__gone">
          That content no longer exists. The report can only be dismissed.
        </p>
      )}

      {report.details ? (
        <p className="report-row__details">
          <span className="report-row__label">Reporter said</span>
          {report.details}
        </p>
      ) : null}

      <div className="report-row__foot">
        <span className="report-row__by">
          Reported by @{report.reporter.username}
          {report.status === 'RESOLVED' && report.resolvedBy ? (
            <>
              {' · '}
              {report.action === 'DISMISS' ? 'Dismissed' : 'Actioned'} by @
              {report.resolvedBy.username}
            </>
          ) : null}
        </span>

        {open ? (
          <Button variant="secondary" onClick={onAct}>
            Review
          </Button>
        ) : null}
      </div>

      {report.note ? (
        <p className="report-row__details">
          <span className="report-row__label">Moderator note</span>
          {report.note}
        </p>
      ) : null}
    </article>
  )
}

/* Acting on one ---------------------------------------------------------- */

function ResolveDialog({
  report,
  onClose,
  onResolved,
}: {
  report: Report
  onClose: () => void
  onResolved: (report: Report) => void
}) {
  /**
   * A report whose content is gone can only be dismissed -- the API says so
   * with a 404 -- so the other two are not offered rather than offered and
   * refused.
   */
  const gone = report.target === null
  const actions = gone
    ? REPORT_ACTIONS.filter((option) => option.value === 'DISMISS')
    : REPORT_ACTIONS

  const [action, setAction] = useState<ReportAction>('DISMISS')
  const [note, setNote] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit() {
    setPending(true)
    setError(null)

    try {
      const updated = await moderationApi.resolveReport(report.id, {
        action,
        ...(note.trim() ? { note: note.trim() } : {}),
      })
      onResolved(updated)
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : 'That did not go through. Please try again.',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open
      onClose={pending ? () => {} : onClose}
      title="Review this report"
      description={
        gone
          ? 'The content is gone, so dismissing is the only way to close this.'
          : 'Hiding tells the author what rule was applied. Everyone who reported it is told the outcome either way.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant={action === 'DISMISS' ? 'primary' : 'danger'}
            loading={pending}
            onClick={onSubmit}
          >
            {action === 'DISMISS' ? 'Dismiss' : 'Apply'}
          </Button>
        </>
      }
    >
      <fieldset className="report-reasons">
        <legend className="report-reasons__legend">What should happen</legend>
        {actions.map((option) => (
          <label className="report-reason" key={option.value}>
            <input
              type="radio"
              name="moderation-action"
              className="report-reason__input"
              value={option.value}
              checked={action === option.value}
              disabled={pending}
              onChange={() => {
                setAction(option.value)
                setError(null)
              }}
            />
            <span className="report-reason__body">
              <span className="report-reason__label">{option.label}</span>
              <span className="report-reason__hint">{option.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <TextField
        multiline
        rows={2}
        label="Note for other moderators"
        placeholder="Optional — never shown to the reporter or the author."
        value={note}
        disabled={pending}
        onChange={(event) => setNote(event.target.value)}
      />

      {error ? (
        <p className="dialog__error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  )
}
