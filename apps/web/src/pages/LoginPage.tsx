import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { isValidEmail, useAuth } from '../lib/auth'
import { useToast } from '../lib/toast'
import { Button } from '../components/ui/Button'
import { Checkbox } from '../components/ui/Checkbox'
import { Icon } from '../components/ui/Icon'
import { PasswordField, TextField } from '../components/ui/TextField'
import { InlineNotice } from '../components/ui/States'
import { AuthLayout } from './AuthLayout'

interface FieldErrors {
  email?: string
  password?: string
}

export function LoginPage() {
  const { signIn, signInWithGoogle } = useAuth()
  const { showToast } = useToast()
  const navigate = useNavigate()
  const location = useLocation()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [googlePending, setGooglePending] = useState(false)

  /** Where the user was headed before being asked to sign in. */
  const destination =
    (location.state as { from?: string } | null)?.from ?? '/home'

  function validate(): FieldErrors {
    const next: FieldErrors = {}
    if (email.trim().length === 0) next.email = 'Enter your email address.'
    else if (!isValidEmail(email)) next.email = 'That email address does not look right.'
    if (password.length === 0) next.password = 'Enter your password.'
    return next
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (submitting) return

    const nextErrors = validate()
    setErrors(nextErrors)
    setFormError(null)
    if (Object.keys(nextErrors).length > 0) return

    setSubmitting(true)
    try {
      const user = await signIn({ email, password, remember })
      showToast({ message: `Welcome back, ${user.displayName.split(' ')[0]}.` })
      navigate(destination, { replace: true })
    } catch (error) {
      // The form keeps its values so nothing has to be retyped.
      setFormError(
        error instanceof Error ? error.message : 'We could not sign you in. Please try again.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  async function onGoogle() {
    setGooglePending(true)
    setFormError(null)
    try {
      const { created } = await signInWithGoogle()
      navigate(created ? '/onboarding' : destination, { replace: true })
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : 'Google sign-in did not complete. Please try again.',
      )
    } finally {
      setGooglePending(false)
    }
  }

  return (
    <AuthLayout
      variant="login"
      title="Welcome back"
      subtitle="Your shelves, streaks and clubs are exactly where you left them."
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
          error={errors.email}
          disabled={submitting}
          onChange={(event) => {
            setEmail(event.target.value)
            setErrors((current) => ({ ...current, email: undefined }))
          }}
        />

        <PasswordField
          label="Password"
          autoComplete="current-password"
          placeholder="Your password"
          value={password}
          error={errors.password}
          disabled={submitting}
          onChange={(event) => {
            setPassword(event.target.value)
            setErrors((current) => ({ ...current, password: undefined }))
          }}
        />

        <div className="auth__row">
          <Checkbox
            checked={remember}
            onChange={setRemember}
            label="Remember me"
            disabled={submitting}
          />
          <Link className="auth__link" to="/forgot-password">
            Forgot password?
          </Link>
        </div>

        <Button variant="primary" size="lg" type="submit" fullWidth loading={submitting}>
          Sign in
        </Button>
      </form>

      <div className="auth__divider">
        <span>or</span>
      </div>

      <Button
        size="lg"
        fullWidth
        loading={googlePending}
        onClick={onGoogle}
        startIcon={<Icon name="google" size="1.1rem" />}
      >
        Continue with Google
      </Button>

      <p className="auth__alt">
        New to Scribe? <Link to="/register">Create an account</Link>
      </p>
    </AuthLayout>
  )
}
