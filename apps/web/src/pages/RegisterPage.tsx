import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  PASSWORD_RULES,
  isValidEmail,
  isValidUsername,
  passwordStrength,
  useAuth,
} from '../lib/auth'
import { cn } from '../lib/cn'
import { Button } from '../components/ui/Button'
import { Checkbox } from '../components/ui/Checkbox'
import { Icon } from '../components/ui/Icon'
import { PasswordField, TextField } from '../components/ui/TextField'
import { InlineNotice } from '../components/ui/States'
import { AuthAside } from './AuthAside'
import './auth.css'

interface FieldErrors {
  username?: string
  email?: string
  password?: string
  confirm?: string
  terms?: string
}

export function RegisterPage() {
  const { register, signInWithGoogle } = useAuth()
  const navigate = useNavigate()

  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [accepted, setAccepted] = useState(false)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [googlePending, setGooglePending] = useState(false)

  const strength = passwordStrength(password)

  function validate(): FieldErrors {
    const next: FieldErrors = {}

    if (username.trim().length === 0) next.username = 'Pick a username.'
    else if (!isValidUsername(username)) {
      next.username = '3–24 letters, numbers or underscores.'
    }

    if (email.trim().length === 0) next.email = 'Enter your email address.'
    else if (!isValidEmail(email)) next.email = 'That email address does not look right.'

    if (password.length === 0) next.password = 'Choose a password.'
    else if (strength.score < 2) next.password = 'Please choose a stronger password.'

    if (confirm.length === 0) next.confirm = 'Re-enter your password.'
    else if (confirm !== password) next.confirm = 'These passwords do not match.'

    if (!accepted) next.terms = 'Please accept the terms to continue.'

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
      await register({ username, email, password })
      // New accounts go straight into onboarding to build the first feed.
      navigate('/onboarding', { replace: true })
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : 'We could not create your account. Please try again.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  async function onGoogle() {
    setGooglePending(true)
    try {
      await signInWithGoogle()
      navigate('/onboarding', { replace: true })
    } catch {
      setFormError('Google sign-up did not complete. Please try again.')
    } finally {
      setGooglePending(false)
    }
  }

  return (
    <div className="auth">
      <div className="auth__panel">
        <div className="auth__form-wrap">
          <Link className="auth__back" to="/">
            <Icon name="arrow-left" size="0.9em" />
            Back to Scribe
          </Link>

          <header className="auth__head">
            <h1>Create your account</h1>
            <p>Free to read, free to publish. No card, no catch.</p>
          </header>

          {formError ? <InlineNotice tone="danger">{formError}</InlineNotice> : null}

          <form className="auth__form" onSubmit={onSubmit} noValidate>
            <TextField
              label="Username"
              autoComplete="username"
              placeholder="quietreader"
              hint="This is how other readers will see you."
              value={username}
              error={errors.username}
              disabled={submitting}
              maxLength={24}
              onChange={(event) => {
                setUsername(event.target.value)
                setErrors((current) => ({ ...current, username: undefined }))
              }}
            />

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
              autoComplete="new-password"
              placeholder="Choose a password"
              value={password}
              error={errors.password}
              disabled={submitting}
              onChange={(event) => {
                setPassword(event.target.value)
                setErrors((current) => ({ ...current, password: undefined }))
              }}
              footer={
                <div className="strength">
                  <div className="strength__meter" aria-hidden="true">
                    {[1, 2, 3, 4].map((step) => (
                      <span
                        key={step}
                        className={cn(
                          'strength__step',
                          strength.score >= step && `is-on is-level-${strength.score}`,
                        )}
                      />
                    ))}
                  </div>
                  <p className="strength__label" aria-live="polite">
                    {strength.label}
                  </p>
                  <ul className="strength__rules">
                    {PASSWORD_RULES.map((rule) => {
                      const met = strength.passed.includes(rule.id)
                      return (
                        <li key={rule.id} className={cn(met && 'is-met')}>
                          <Icon name={met ? 'check-circle' : 'minus'} size="0.85em" />
                          {rule.label}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              }
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

            <Checkbox
              checked={accepted}
              onChange={(next) => {
                setAccepted(next)
                setErrors((current) => ({ ...current, terms: undefined }))
              }}
              error={errors.terms}
              disabled={submitting}
              label={
                <>
                  I agree to the <Link to="/terms">Terms</Link> and{' '}
                  <Link to="/privacy">Privacy Policy</Link>
                </>
              }
            />

            <Button variant="primary" size="lg" type="submit" fullWidth loading={submitting}>
              Create Account
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
            Already have an account? <Link to="/login">Sign in</Link>
          </p>
        </div>
      </div>

      <AuthAside variant="register" />
    </div>
  )
}
