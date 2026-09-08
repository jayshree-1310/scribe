import { useState } from 'react'
import { useAsync } from '../hooks/useAsync'
import * as api from '../data/api'
import type { ChallengeState } from '../types/domain'
import { AppShell } from '../components/layout/AppShell'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { Skeleton } from '../components/ui/Skeleton'
import { Tabs, TabPanel } from '../components/ui/Tabs'
import { EmptyState, ErrorState } from '../components/ui/States'
import { ChallengeCard } from '../components/story/Cards'
import { Link } from 'react-router-dom'
import './pages.css'

const TABS = [
  { id: 'active' as const, label: 'Active' },
  { id: 'upcoming' as const, label: 'Upcoming' },
  { id: 'completed' as const, label: 'Completed' },
]

export function ChallengesPage() {
  const challenges = useAsync(() => api.getChallenges(), [])
  const [tab, setTab] = useState<ChallengeState>('active')

  const shown = challenges.data?.filter((challenge) => challenge.state === tab) ?? []
  const counts = (state: ChallengeState) =>
    challenges.data?.filter((challenge) => challenge.state === state).length

  return (
    <AppShell>
      <header className="page-head">
        <div>
          <h1 className="page-head__title">Writing challenges</h1>
          <p className="page-head__sub">
            A prompt, a deadline, and a few thousand people writing to the same
            brief. The fastest way to finish something.
          </p>
        </div>
        <Button variant="primary" startIcon={<Icon name="plus" size="1em" />}>
          Host a challenge
        </Button>
      </header>

      <div className="page-tabs">
        <Tabs
          items={TABS.map((item) => ({ ...item, count: counts(item.id) }))}
          active={tab}
          onChange={setTab}
          label="Challenge status"
        />
      </div>

      <TabPanel id={tab}>
        {challenges.status === 'error' ? (
          <ErrorState message={challenges.error} onRetry={challenges.reload} />
        ) : challenges.status === 'loading' ? (
          <div className="card-grid">
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} height="13rem" radius="var(--radius-lg)" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <EmptyState
            icon="trophy"
            title={`No ${tab} challenges`}
            description={
              tab === 'upcoming'
                ? 'Nothing announced yet — check back soon.'
                : 'Nothing here right now.'
            }
          />
        ) : (
          <div className="card-grid">
            {shown.map((challenge) => (
              <Link key={challenge.id} to={`/challenges/${challenge.slug}`} className="card-link">
                <ChallengeCard challenge={challenge} />
              </Link>
            ))}
          </div>
        )}
      </TabPanel>
    </AppShell>
  )
}
