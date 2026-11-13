import { useLocation } from 'react-router-dom'
import { ButtonLink } from '../ui/Button'
import { Icon } from '../ui/Icon'

/**
 * What a signed-out visitor sees where a comment form would be.
 *
 * Story and chapter pages are open to anybody with the link, but taking part
 * needs an account. Sign-in returns them to this page: `LoginPage` reads
 * `from` off the location state, the same contract `RequireAuth` uses.
 */
export function SignInPrompt({ action }: { action: string }) {
  const location = useLocation()

  return (
    <div className="signin-prompt">
      <p>Sign in to {action}.</p>
      <ButtonLink
        to="/login"
        state={{ from: location.pathname }}
        variant="primary"
        size="sm"
        startIcon={<Icon name="user" size="0.95em" />}
      >
        Sign in
      </ButtonLink>
    </div>
  )
}
