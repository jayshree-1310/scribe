import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { PASSWORD_MIN, passwordStrength } from '../lib/auth'
import { useToast } from '../lib/toast'
import { ApiError } from '../lib/api-client'
import { resetPassword } from '../data/auth-api'
import { Button } from '../components/ui/Button'
import { PasswordField } from '../components/ui/TextField'
import { PasswordStrength } from '../components/ui/PasswordStrength'
import { InlineNotice } from '../components/ui/States'
import { AuthLayout } from './AuthLayout'

interface FieldErrors {
  password?: string
  confirm?: string
}

/**
 * Sets a new password from an emailed link.
 *
 * No session is issued on success — the API revokes every session on a reset,
 * including any an intruder was holding — so this ends at the sign-in page
 * rather than in the app.
 */
export function ResetPasswordPage() {
  const { token = '' } = useParams()
  const navigate = useNavigate()
  const { showToast } = useToast()

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [expired, setExpired] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (submitting) return

    const next: FieldErrors = {}
    if (password.length === 0) next.password = 'Choose a password.'
    else if (password.length < PASSWORD_MIN) {
      next.password = `Use at least ${PASSWORD_MIN} characters.`
    } else if (passwordStrength(password).score < 2) {
      next.password = 'Please choose a stronger password.'
    }
    if (confirm !== password) next.confirm = 'These passwords do not match.'

    setErrors(next)
    setFormError(null)
    if (Object.keys(next).length > 0) return

    setSubmitting(true)
    try {
      await resetPassword({ token, password })
      showToast({ message: 'Password changed. Sign in with your new one.' })
      navigate('/login', { replace: true })
    } catch (cause) {
      if (cause instanceof ApiError) {
        // A dead link is not something retyping the form can fix, so the page
        // stops offering the form and points at the only useful next step.
        if (cause.fieldErrors['token']) setExpired(true)
        else setErrors(cause.fieldErrors)
        setFormError(cause.message)
      } else {
        setFormError('We could not change your password. Please try again.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  if (expired) {
    return (
      <AuthLayout
        variant="login"
        showSwitch={false}
        title="This link has expired"
        subtitle="Reset links last 30 minutes and can only be used once. Ask for a fresh one and it will work."
      >
        <div className="auth__form">
          <Button variant="primary" size="lg" fullWidth onClick={() => navigate('/forgot-password')}>
            Request a new link
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
      title="Choose a new password"
      subtitle="Setting this signs you out everywhere else, so anyone else holding your old password loses access."
    >
      {formError ? <InlineNotice tone="danger">{formError}</InlineNotice> : null}

      <form className="auth__form" onSubmit={onSubmit} noValidate>
        <PasswordField
          label="New password"
          autoComplete="new-password"
          placeholder="Choose a password"
          value={password}
          error={errors.password}
          disabled={submitting}
          onChange={(event) => {
            setPassword(event.target.value)
            setErrors((current) => ({ ...current, password: undefined }))
          }}
          footer={<PasswordStrength value={password} />}
        />

        <PasswordField
          label="Confirm password"
          autoComplete="new-password"
          placeholder="Re-enter your password"
          value={confirm}
          error={errors.confirm}
          disabled={submitting}
          onChange={(event) => {
            setConfirm(event.target.value)
            setErrors((current) => ({ ...current, confirm: undefined }))
          }}
        />

        <Button variant="primary" size="lg" type="submit" fullWidth loading={submitting}>
          Set new password
        </Button>
      </form>

      <p className="auth__alt">
        Changed your mind? <Link to="/login">Back to sign in</Link>
      </p>
    </AuthLayout>
  )
}
