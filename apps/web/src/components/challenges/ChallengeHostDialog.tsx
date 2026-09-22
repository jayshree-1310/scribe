import { useState } from 'react'
import { ApiError } from '../../lib/api-client'
import * as challengesApi from '../../data/challenges-api'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { TextField } from '../ui/TextField'
import type { Challenge } from '../../types/challenges'
import './challenge-host.css'

/**
 * Hosting a challenge: the form behind `POST` / `PATCH /api/challenges`.
 *
 * Those endpoints have been covered by tests and reachable with a token since
 * Task 11, which meant the create and edit paths had never been exercised by a
 * person -- the only way to make one outside the seed script was the API
 * directly. This is that surface.
 *
 * One dialog for both, because the two differ in a verb and a starting value.
 * A separate edit form would be the same six fields with a different heading,
 * and the day a seventh field is added is the day one of them would not get it.
 *
 * **The datetime conversion is the fiddly part.** `<input type="datetime-local">`
 * yields `2026-04-01T09:00` -- no zone at all -- while the API's schema demands
 * an offset. Reading that string with `new Date` interprets it in the browser's
 * zone, which is what a host means when they type a time: their own clock.
 */

/** ISO with an offset, from what a `datetime-local` input gives. */
function toIso(local: string): string {
  return new Date(local).toISOString()
}

/** And back, because the input cannot parse what `toIso` produced. */
function toLocalInput(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''

  // Not `toISOString().slice(...)`: that would shift the value back to UTC and
  // show the host a different clock from the one they typed into.
  const pad = (value: number) => String(value).padStart(2, '0')

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

interface ChallengeHostDialogProps {
  /** Absent when hosting a new one. */
  challenge?: Challenge
  onClose: () => void
  onSaved: (challenge: Challenge) => void
}

export function ChallengeHostDialog({
  challenge,
  onClose,
  onSaved,
}: ChallengeHostDialogProps) {
  const editing = challenge !== undefined

  const [title, setTitle] = useState(challenge?.title ?? '')
  const [prompt, setPrompt] = useState(challenge?.prompt ?? '')
  const [description, setDescription] = useState(challenge?.description ?? '')
  const [wordTarget, setWordTarget] = useState(
    challenge?.wordTarget === null || challenge?.wordTarget === undefined
      ? ''
      : String(challenge.wordTarget),
  )
  const [startsAt, setStartsAt] = useState(
    challenge ? toLocalInput(challenge.startsAt) : '',
  )
  const [endsAt, setEndsAt] = useState(
    challenge ? toLocalInput(challenge.endsAt) : '',
  )

  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit() {
    /**
     * Checked here as well as by the API, which owns the rule. This only saves
     * a round trip to be told what the form already knows -- and the window
     * check is worth catching early because the server's message is about a
     * pair of fields rather than about either one.
     */
    if (!title.trim() || !prompt.trim() || !startsAt || !endsAt) {
      setError('A title, a brief and both dates are needed.')
      return
    }

    if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
      setError('The challenge has to end after it starts.')
      return
    }

    setPending(true)
    setError(null)

    const draft = {
      title: title.trim(),
      prompt: prompt.trim(),
      description: description.trim() ? description.trim() : null,
      wordTarget: wordTarget.trim() ? Number(wordTarget) : null,
      startsAt: toIso(startsAt),
      endsAt: toIso(endsAt),
    }

    try {
      const saved = editing
        ? await challengesApi.updateChallenge(challenge.id, draft)
        : await challengesApi.createChallenge(draft)

      onSaved(saved)
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : 'That did not save. Please try again.',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open
      onClose={pending ? () => {} : onClose}
      title={editing ? 'Edit challenge' : 'Host a challenge'}
      description={
        editing
          ? 'Changing the window moves the challenge for everybody already entered.'
          : 'A brief and a deadline. Writers attach a published story to take a place on the board.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} onClick={onSubmit}>
            {editing ? 'Save changes' : 'Create challenge'}
          </Button>
        </>
      }
    >
      <TextField
        label="Title"
        value={title}
        maxLength={160}
        disabled={pending}
        onChange={(event) => setTitle(event.target.value)}
      />

      <TextField
        multiline
        rows={2}
        label="The brief"
        placeholder="One or two lines writers are answering."
        value={prompt}
        maxLength={500}
        counterMax={500}
        disabled={pending}
        onChange={(event) => setPrompt(event.target.value)}
      />

      <TextField
        multiline
        rows={3}
        label="Description"
        placeholder="Optional — rules, judging, anything else worth saying."
        value={description}
        maxLength={4000}
        disabled={pending}
        onChange={(event) => setDescription(event.target.value)}
      />

      <TextField
        type="number"
        label="Word target"
        placeholder="Optional"
        value={wordTarget}
        disabled={pending}
        onChange={(event) => setWordTarget(event.target.value)}
      />

      <div className="host-dialog__window">
        <TextField
          type="datetime-local"
          label="Opens"
          value={startsAt}
          disabled={pending}
          onChange={(event) => setStartsAt(event.target.value)}
        />
        <TextField
          type="datetime-local"
          label="Closes"
          value={endsAt}
          disabled={pending}
          onChange={(event) => setEndsAt(event.target.value)}
        />
      </div>

      {error ? (
        <p className="dialog__error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  )
}
