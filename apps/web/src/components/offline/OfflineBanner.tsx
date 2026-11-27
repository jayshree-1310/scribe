import { useAuth } from '../../lib/auth'
import { useOnline } from '../../lib/network-status'
import { useOffline } from '../../lib/offline'
import { ButtonLink } from '../ui/Button'
import { Icon } from '../ui/Icon'
import './offline.css'

/**
 * Across the top of the app while the browser is offline: most of Scribe
 * needs the server, so pages will fail to load, and this says why before they
 * do -- and where the stories that still work are.
 */
export function OfflineBanner() {
  const online = useOnline()
  const { session } = useAuth()
  const offline = useOffline()

  if (online) return null

  const count = session ? offline.stories.length : 0

  return (
    <div className="offline-banner" role="status">
      <span className="offline-banner__icon">
        <Icon name="cloud-off" size="1rem" />
      </span>
      <p className="offline-banner__text">
        <strong>You're offline.</strong>{' '}
        {count > 0
          ? `Your ${count === 1 ? 'saved story' : `${count} saved stories`} can still be read; the rest of Scribe comes back when you reconnect.`
          : 'Scribe needs a connection for most things. Stories you save for offline reading can be read without one.'}
      </p>
      {count > 0 ? (
        <ButtonLink size="sm" variant="secondary" to="/library?shelf=offline">
          Saved stories
        </ButtonLink>
      ) : null}
    </div>
  )
}
