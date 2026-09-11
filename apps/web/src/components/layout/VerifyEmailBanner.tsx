import { useState } from 'react'
import { useAuth } from '../../lib/auth'
import { useToast } from '../../lib/toast'
import { ApiError } from '../../lib/api-client'
import { sendVerificationEmail } from '../../data/auth-api'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'

/** Remembered per tab, so dismissing it silences today rather than for ever. */
const DISMISSED_KEY = 'scribe:verify-banner-dismissed'

function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * The nudge to confirm an email address.
 *
 * Shown across the app rather than only in settings, because the address is
 * how an account is recovered: someone who never notices it is unverified
 * finds out at the worst possible moment, when they have lost their password.
 *
 * Dismissible, and dismissal lives in `sessionStorage` — a banner that cannot
 * be silenced is one people learn to look past, and one silenced for ever
 * stops doing its job.
 */
export function VerifyEmailBanner() {
  const { session } = useAuth()
  const { showToast } = useToast()
  const [dismissed, setDismissed] = useState(readDismissed)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  // `emailVerified` is absent on a session restored from an older stored
  // shape; nagging on a maybe is worse than missing one page view.
  if (!session || session.user.emailVerified !== false || dismissed) return null

  async function onResend() {
    setSending(true)
    try {
      await sendVerificationEmail()
      setSent(true)
      showToast({ message: 'Confirmation link sent. Check your inbox.' })
    } catch (cause) {
      showToast({
        tone: 'error',
        message:
          cause instanceof ApiError
            ? cause.message
            : 'We could not send that link. Please try again.',
      })
    } finally {
      setSending(false)
    }
  }

  function dismiss() {
    setDismissed(true)
    try {
      sessionStorage.setItem(DISMISSED_KEY, '1')
    } catch {
      // Non-fatal: it comes back on the next page instead.
    }
  }

  return (
    <div className="verify-banner" role="status">
      <span className="verify-banner__icon">
        <Icon name="alert" size="1rem" />
      </span>

      <p className="verify-banner__text">
        <strong>Confirm your email address.</strong> We sent a link to{' '}
        {session.user.email}. Until it's confirmed you won't be able to reset
        your password.
      </p>

      <div className="verify-banner__actions">
        <Button
          size="sm"
          variant="secondary"
          loading={sending}
          disabled={sent}
          onClick={() => void onResend()}
        >
          {sent ? 'Link sent' : 'Resend link'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          aria-label="Dismiss"
          onClick={dismiss}
          startIcon={<Icon name="close" size="1rem" />}
        />
      </div>
    </div>
  )
}
