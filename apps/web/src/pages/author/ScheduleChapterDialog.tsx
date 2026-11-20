import { useState } from 'react'
import { ApiError } from '../../lib/api-client'
import { formatDayAndTime, formatRelative } from '../../lib/format'
import { isoToLocalInput, localInputToIso } from '../../lib/local-datetime'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { TextField } from '../../components/ui/TextField'

/**
 * Picking when a draft chapter goes live by itself.
 *
 * The time is typed on the author's own clock (see `lib/local-datetime.ts`),
 * and the zone is named under the field so nobody schedules for 9 AM
 * believing it means their readers' 9 AM. The server makes the real checks
 * (at least a minute ahead, within a year, not empty); the only check here
 * is that something was picked, so the message for anything else is the
 * server's own.
 */

/** Tomorrow at 9 AM local time: a sensible first suggestion. */
function tomorrowMorning(): string {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  date.setHours(9, 0, 0, 0)
  return isoToLocalInput(date.toISOString())
}

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

interface ScheduleChapterDialogProps {
  open: boolean
  chapterTitle: string
  /** The schedule it already has, when changing one. */
  scheduledAt: string | null
  onClose: () => void
  /** Saves the schedule; a rejection is shown in the dialog. */
  onSchedule: (at: string) => Promise<void>
}

export function ScheduleChapterDialog({
  open,
  chapterTitle,
  scheduledAt,
  onClose,
  onSchedule,
}: ScheduleChapterDialogProps) {
  const [value, setValue] = useState(() =>
    scheduledAt ? isoToLocalInput(scheduledAt) : tomorrowMorning(),
  )
  const [error, setError] = useState<string | undefined>()
  const [pending, setPending] = useState(false)

  const preview =
    value && !Number.isNaN(new Date(value).getTime()) ? localInputToIso(value) : null

  async function submit() {
    if (!preview) {
      setError('Pick a date and time.')
      return
    }

    setPending(true)
    setError(undefined)
    try {
      await onSchedule(preview)
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? (cause.fieldErrors['at'] ?? cause.fieldErrors['content'] ?? cause.message)
          : 'We could not schedule that chapter.',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={scheduledAt ? 'Change release time' : 'Schedule release'}
      description={`“${chapterTitle || 'Untitled'}” goes live by itself at this time, and readers of the story are notified.`}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} onClick={() => void submit()}>
            {scheduledAt ? 'Save time' : 'Schedule'}
          </Button>
        </>
      }
    >
      <TextField
        type="datetime-local"
        label="Release at"
        value={value}
        disabled={pending}
        error={error}
        hint={
          preview
            ? `${formatDayAndTime(preview)} (${formatRelative(preview)}), your time zone: ${ZONE}`
            : `Your time zone: ${ZONE}`
        }
        onChange={(event) => {
          setValue(event.target.value)
          setError(undefined)
        }}
      />
    </Dialog>
  )
}
