import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { ApiError } from '../lib/api-client'
import { verifyEmail } from '../data/auth-api'
import { getMyAccount } from '../data/account-api'
import { Spinner } from '../components/ui/Spinner'
import { InlineNotice } from '../components/ui/States'
import { AuthLayout } from './AuthLayout'

type Phase =
  | { state: 'working' }
  | { state: 'done'; email: string }
  | { state: 'failed'; message: string }

/**
 * The other end of the link in a verification email.
 *
 * Verifies on mount rather than behind a button: the person already clicked
 * something, and a second click that says "yes, really" adds a step without
 * adding a decision. It is safe here because the token is single-use and the
 * only thing spending it does is confirm an address.
 *
 * Public, because the link is very often opened in whichever browser the mail
 * client hands it to — signed in or not.
 */
export function VerifyEmailPage() {
  const { token = '' } = useParams()
  const { session, adoptProfile } = useAuth()
  const [phase, setPhase] = useState<Phase>({ state: 'working' })

  // Guards StrictMode's development double-mount, which would otherwise spend
  // the token on the first pass and report the second as an expired link.
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true

    void (async () => {
      try {
        const { email } = await verifyEmail(token)
        setPhase({ state: 'done', email })

        // Signed in in this browser: refresh the session so the banner in the
        // app shell goes away without a reload.
        if (session) {
          try {
            adoptProfile(await getMyAccount())
          } catch {
            // Cosmetic only — the address is verified either way.
          }
        }
      } catch (cause) {
        setPhase({
          state: 'failed',
          message:
            cause instanceof ApiError
              ? cause.message
              : 'We could not confirm that address. Please try again.',
        })
      }
    })()
    // Runs once, for the token in the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (phase.state === 'working') {
    return (
      <AuthLayout
        variant="login"
        showSwitch={false}
        title="Confirming your address"
        subtitle="One moment."
      >
        <div className="auth__form">
          <Spinner />
        </div>
      </AuthLayout>
    )
  }

  if (phase.state === 'failed') {
    return (
      <AuthLayout
        variant="login"
        showSwitch={false}
        title="That link didn't work"
        subtitle="Confirmation links last 24 hours and can only be used once."
      >
        <InlineNotice tone="danger">{phase.message}</InlineNotice>

        <p className="auth__alt">
          {session ? (
            <>
              Signed in? <Link to="/settings?section=security">Send a new link</Link>
            </>
          ) : (
            <>
              <Link to="/login">Sign in</Link> and we'll offer you a fresh one.
            </>
          )}
        </p>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout
      variant="login"
      showSwitch={false}
      title="Address confirmed"
      subtitle={`${phase.email} is now verified on your Scribe account.`}
    >
      <InlineNotice tone="success" icon="check-circle">
        You can close this tab, or carry on reading.
      </InlineNotice>

      <p className="auth__alt">
        <Link to={session ? '/home' : '/login'}>
          {session ? 'Back to your feed' : 'Sign in'}
        </Link>
      </p>
    </AuthLayout>
  )
}
