import { useAsync } from '../hooks/useAsync'
import * as api from '../data/api'
import { AppShell } from '../components/layout/AppShell'
import { Button } from '../components/ui/Button'
import { SectionHead } from '../components/ui/Card'
import { Icon } from '../components/ui/Icon'
import { Skeleton } from '../components/ui/Skeleton'
import { EmptyState, ErrorState } from '../components/ui/States'
import { ChannelCard } from '../components/story/Cards'
import './pages.css'

export function ChannelsPage() {
  const channels = useAsync(() => api.getChannels(), [])

  const subscribed = channels.data?.filter((channel) => channel.subscribed) ?? []
  const rest = channels.data?.filter((channel) => !channel.subscribed) ?? []

  return (
    <AppShell>
      <header className="page-head">
        <div>
          <h1 className="page-head__title">Broadcast channels</h1>
          <p className="page-head__sub">
            Authors post here between chapters — release notes, cut scenes and
            the occasional map.
          </p>
        </div>
        <Button variant="primary" startIcon={<Icon name="plus" size="1em" />}>
          Create a channel
        </Button>
      </header>

      {channels.status === 'error' ? (
        <ErrorState message={channels.error} onRetry={channels.reload} />
      ) : channels.status === 'loading' ? (
        <div className="card-grid card-grid--wide">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} height="12rem" radius="var(--radius-lg)" />
          ))}
        </div>
      ) : (
        <>
          <section className="page-section">
            <SectionHead title="Subscribed" subtitle={`${subscribed.length} channels`} />
            {subscribed.length === 0 ? (
              <EmptyState
                size="sm"
                icon="megaphone"
                title="No subscriptions yet"
                description="Subscribe to a channel and its posts arrive in your feed."
              />
            ) : (
              <div className="card-grid card-grid--wide">
                {subscribed.map((channel) => (
                  <ChannelCard key={channel.id} channel={channel} />
                ))}
              </div>
            )}
          </section>

          <section className="page-section">
            <SectionHead title="Discover channels" />
            <div className="card-grid card-grid--wide">
              {rest.map((channel) => (
                <ChannelCard key={channel.id} channel={channel} />
              ))}
            </div>
          </section>
        </>
      )}
    </AppShell>
  )
}
