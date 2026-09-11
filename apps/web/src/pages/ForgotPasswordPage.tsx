import { useState } from 'react'
import { Link } from 'react-router-dom'
import { isValidEmail } from '../lib/auth'
import { ApiError } from '../lib/api-client'
import { requestPasswordReset } from '../data/auth-api'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { TextField } from '../components/ui/TextField'
import { InlineNotice } from '../components/ui/States'
import { AuthLayout } from './AuthLayout'

/**
 * Asks for a reset link.
 *
 * The confirmation deliberately says "if that address has an account" and
 * never "we have sent you an email": the API refuses to reveal whether an
 * address is registered, and a page that phrased the success differently for
 * a known address would hand back the very thing the API withheld.
 */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [sent, setSent] = useState(false)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (submitting) return

    if (email.trim().length === 0) {
      setError('Enter your email address.')
      return
    }
    if (!isValidEmail(email)) {
      setError('That email address does not look right.')
      return
    }

    setSubmitting(true)
    setFormError(null)
    try {
      await requestPasswordReset(email.trim().toLowerCase())
      setSent(true)
    } catch (cause) {
      setFormError(
        cause instanceof ApiError
          ? cause.message
          : 'We could not send that link. Please try again.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  if (sent) {
    return (
      <AuthLayout
        variant="login"
        showSwitch={false}
        title="Check your inbox"
        subtitle={`If ${email.trim().toLowerCase()} has a Scribe account, a link to choose a new password is on its way.`}
      >
        <InlineNotice tone="info" icon="clock">
          The link is good for 30 minutes and can only be used once.
        </InlineNotice>

        <div className="auth__form">
          <Button
            size="lg"
            fullWidth
            onClick={() => setSent(false)}
            startIcon={<Icon name="retry" />}
          >
            Use a different address
          </Button>
        </div>

        <p className="auth__alt">
          Remembered it? <Link to="/login">Back to sign in</Link>
        </p>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout
      variant="login"
      showSwitch={false}
      title="Forgot your password?"
      subtitle="Give us the address on your account and we'll email you a link to set a new one."
    >
      {formError ? <InlineNotice tone="danger">{formError}</InlineNotice> : null}

      <form className="auth__form" onSubmit={onSubmit} noValidate>
        <TextField
          label="Email"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          error={error}
          disabled={submitting}
          onChange={(event) => {
            setEmail(event.target.value)
            setError(undefined)
          }}
        />

        <Button variant="primary" size="lg" type="submit" fullWidth loading={submitting}>
          Email me a link
        </Button>
      </form>

      <p className="auth__alt">
        Remembered it? <Link to="/login">Back to sign in</Link>
      </p>
    </AuthLayout>
  )
}
