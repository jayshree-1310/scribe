import { useState } from 'react'
import { useAsync } from '../hooks/useAsync'
import { useToast } from '../lib/toast'
import * as channelsApi from '../data/channels-api'
import { AppShell } from '../components/layout/AppShell'
import { Button } from '../components/ui/Button'
import { SectionHead } from '../components/ui/Card'
import { Dialog } from '../components/ui/Dialog'
import { Icon } from '../components/ui/Icon'
import { Skeleton } from '../components/ui/Skeleton'
import { TextField } from '../components/ui/TextField'
import { EmptyState, ErrorState } from '../components/ui/States'
import { ChannelCard } from '../components/story/Cards'
import './pages.css'

export function ChannelsPage() {
  const { showToast } = useToast()

  /**
   * Two requests rather than one list partitioned in the browser: the
   * subscribed set is a server-side filter, so this stays correct once the
   * catalogue outgrows a single page.
   */
  const subscribed = useAsync(
    () => channelsApi.listChannels({ subscribed: true, limit: 24 }),
    [],
  )
  const all = useAsync(() => channelsApi.listChannels({ limit: 24 }), [])

  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [creating, setCreating] = useState(false)

  const subscribedIds = new Set(
    (subscribed.data?.items ?? []).map((channel) => channel.id),
  )
  const rest = (all.data?.items ?? []).filter(
    (channel) => !subscribedIds.has(channel.id),
  )

  async function onCreate() {
    const trimmed = name.trim()
    if (trimmed.length < 2) {
      setError('Give the channel a name.')
      return
    }

    setCreating(true)
    try {
      const channel = await channelsApi.createChannel({
        name: trimmed,
        description: description.trim() || null,
      })

      setCreateOpen(false)
      setName('')
      setDescription('')
      setError(undefined)
      showToast({ message: `${channel.name} is live.` })
      all.reload()
      subscribed.reload()
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'We could not create that channel.',
      )
    } finally {
      setCreating(false)
    }
  }

  const loading = all.status === 'loading' || subscribed.status === 'loading'

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
        <Button
          variant="primary"
          onClick={() => setCreateOpen(true)}
          startIcon={<Icon name="plus" size="1em" />}
        >
          Create a channel
        </Button>
      </header>

      {all.status === 'error' ? (
        <ErrorState message={all.error} onRetry={all.reload} />
      ) : loading ? (
        <div className="card-grid card-grid--wide">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} height="12rem" radius="var(--radius-lg)" />
          ))}
        </div>
      ) : (
        <>
          <section className="page-section">
            <SectionHead
              title="Subscribed"
              subtitle={`${subscribed.data?.total ?? 0} channels`}
            />
            {(subscribed.data?.items.length ?? 0) === 0 ? (
              <EmptyState
                size="sm"
                icon="megaphone"
                title="No subscriptions yet"
                description="Subscribe to a channel and its posts arrive in your feed."
              />
            ) : (
              <div className="card-grid card-grid--wide">
                {subscribed.data?.items.map((channel) => (
                  <ChannelCard key={channel.id} channel={channel} />
                ))}
              </div>
            )}
          </section>

          <section className="page-section">
            <SectionHead title="Discover channels" />
            {rest.length === 0 ? (
              <EmptyState
                size="sm"
                icon="megaphone"
                title="No other channels yet"
                description="Start one and readers can opt in to your posts."
                action={
                  <Button variant="primary" onClick={() => setCreateOpen(true)}>
                    Create a channel
                  </Button>
                }
              />
            ) : (
              <div className="card-grid card-grid--wide">
                {rest.map((channel) => (
                  <ChannelCard key={channel.id} channel={channel} />
                ))}
              </div>
            )}
          </section>
        </>
      )}

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create a channel"
        description="Readers who subscribe will see everything you post here."
        dismissible={!creating}
        footer={
          <>
            <Button onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button variant="primary" loading={creating} onClick={onCreate}>
              Create channel
            </Button>
          </>
        }
      >
        <div className="stack" style={{ gap: 'var(--space-5)' }}>
          <TextField
            label="Name"
            placeholder="Notes from the Coast"
            value={name}
            error={error}
            maxLength={120}
            counterMax={120}
            disabled={creating}
            onChange={(event) => {
              setName(event.target.value)
              setError(undefined)
            }}
          />
          <TextField
            multiline
            label="Description"
            placeholder="What will you post here?"
            rows={4}
            value={description}
            maxLength={2000}
            counterMax={2000}
            disabled={creating}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
      </Dialog>
    </AppShell>
  )
}
