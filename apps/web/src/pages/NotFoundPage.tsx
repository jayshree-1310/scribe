import { PublicShell } from '../components/layout/PublicShell'
import { ButtonLink } from '../components/ui/Button'
import { EmptyState } from '../components/ui/States'
import './pages.css'

export function NotFoundPage() {
  return (
    <PublicShell>
      <div className="container not-found">
        <EmptyState
          icon="compass"
          title="This page has wandered off"
          description="The link may be old, or the story may have been unpublished. Try discovering something else."
          action={
            <div className="not-found__actions">
              <ButtonLink variant="primary" to="/discover">
                Browse stories
              </ButtonLink>
              <ButtonLink to="/">Back to home</ButtonLink>
            </div>
          }
        />
      </div>
    </PublicShell>
  )
}
