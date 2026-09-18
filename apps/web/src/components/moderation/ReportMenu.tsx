import { useId, useState } from 'react'
import { ApiError } from '../../lib/api-client'
import { useToast } from '../../lib/toast'
import { reportContent } from '../../data/moderation-api'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { DropdownMenu, MenuItem } from '../ui/DropdownMenu'
import { Icon } from '../ui/Icon'
import { TextField } from '../ui/TextField'
import {
  REPORT_DETAILS_MAX_LENGTH,
  REPORT_REASONS,
} from '../../types/moderation'
import type { ReportReason, ReportTarget } from '../../types/moderation'
import './moderation.css'

interface ReportMenuProps {
  targetType: ReportTarget
  targetId: string
  /** What the dialog calls the thing, e.g. "comment" or "post". */
  noun: string
  /**
   * Hidden for the author's own words. Reporting yourself is refused by the
   * API, and an action that always fails is worse than no action.
   */
  hidden?: boolean
}

/**
 * The overflow menu on a piece of user-written text, and the reason dialog
 * behind its one item.
 *
 * One component for all three surfaces -- story comments, club threads,
 * channel posts -- because the API is one endpoint over one shape, and three
 * copies of a reason list is how three surfaces end up offering three
 * different sets of reasons.
 *
 * The existing inline Delete stays where it is on the surfaces that have one.
 * Folding it in here would be a better menu and a wider change than this task
 * asked for; the overflow menu is additive, and Delete can move into it when
 * somebody is redesigning that row on purpose.
 */
export function ReportMenu({
  targetType,
  targetId,
  noun,
  hidden = false,
}: ReportMenuProps) {
  const { showToast } = useToast()
  // Scopes the radio group to this menu rather than to the page.
  const groupName = useId()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<ReportReason | null>(null)
  const [details, setDetails] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (hidden) return null

  function close() {
    setOpen(false)
    // Reset on close rather than on open, so the dialog's exit animation does
    // not play over the fields emptying.
    setReason(null)
    setDetails('')
    setError(null)
  }

  async function onSubmit() {
    if (reason === null) {
      setError('Pick a reason first.')
      return
    }

    const trimmed = details.trim()
    if (reason === 'OTHER' && trimmed.length === 0) {
      setError('Tell us what is wrong with it.')
      return
    }

    setPending(true)
    setError(null)
    try {
      await reportContent({
        targetType,
        targetId,
        reason,
        ...(trimmed.length > 0 ? { details: trimmed } : {}),
      })

      showToast({ message: 'Thanks — a moderator will take a look.' })
      close()
    } catch (cause) {
      /**
       * Already reported is the outcome this reader wanted, so it closes with
       * the same reassurance rather than an error. Everything else stays in
       * the dialog, where the reason they picked is still there to retry with.
       */
      if (cause instanceof ApiError && cause.status === 409) {
        showToast({ message: 'You have already reported this. We are looking.' })
        close()
        return
      }

      setError(
        cause instanceof Error
          ? cause.message
          : 'We could not send that report.',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <DropdownMenu
        label={`Actions for this ${noun}`}
        align="end"
        trigger={(props) => (
          <Button
            {...props}
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={`Actions for this ${noun}`}
            startIcon={<Icon name="more" />}
          />
        )}
      >
        <MenuItem
          tone="danger"
          icon={<Icon name="alert" size="1em" />}
          onSelect={() => setOpen(true)}
        >
          Report
        </MenuItem>
      </DropdownMenu>

      <Dialog
        open={open}
        onClose={close}
        title={`Report this ${noun}`}
        description="Tell us what is wrong with it. A moderator reads every report."
        size="sm"
        dismissible={!pending}
        footer={
          <>
            <Button onClick={close} disabled={pending}>
              Cancel
            </Button>
            <Button variant="danger" loading={pending} onClick={onSubmit}>
              Send report
            </Button>
          </>
        }
      >
        {/*
          A radio group rather than a select: seven options with a line of
          explanation each is a thing to read, and a closed select hides six of
          them behind a click.
        */}
        <fieldset className="report-reasons">
          <legend className="report-reasons__legend">Reason</legend>
          {REPORT_REASONS.map((option) => (
            <label className="report-reason" key={option.value}>
              <input
                type="radio"
                name={groupName}
                className="report-reason__input"
                value={option.value}
                checked={reason === option.value}
                disabled={pending}
                onChange={() => {
                  setReason(option.value)
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
          rows={3}
          label={reason === 'OTHER' ? 'What is wrong with it?' : 'Anything to add?'}
          placeholder="Optional — a line of context helps."
          value={details}
          maxLength={REPORT_DETAILS_MAX_LENGTH}
          counterMax={REPORT_DETAILS_MAX_LENGTH}
          disabled={pending}
          onChange={(event) => setDetails(event.target.value)}
        />

        {error ? (
          <p className="dialog__error" role="alert">
            {error}
          </p>
        ) : null}
      </Dialog>
    </>
  )
}
