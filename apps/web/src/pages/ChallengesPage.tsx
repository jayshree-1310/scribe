import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAsync } from '../hooks/useAsync'
import * as challengesApi from '../data/challenges-api'
import type { ChallengeState } from '../types/challenges'
import { AppShell } from '../components/layout/AppShell'
import { Skeleton } from '../components/ui/Skeleton'
import { Tabs, TabPanel } from '../components/ui/Tabs'
import { EmptyState, ErrorState } from '../components/ui/States'
import { ChallengeCard } from '../components/story/Cards'
import './pages.css'

const TABS = [
  { id: 'active' as const, label: 'Active' },
  { id: 'upcoming' as const, label: 'Upcoming' },
  { id: 'past' as const, label: 'Past' },
]

const EMPTY_COPY: Record<ChallengeState, string> = {
  active: 'Nothing is running right now — the next one is under Upcoming.',
  upcoming: 'Nothing announced yet — check back soon.',
  past: 'Nothing has finished yet.',
}

export function ChallengesPage() {
  /**
   * One request for all three groups. The API splits them by the window
   * rather than by a stored status, and answers all three at once because the
   * tabs below show a count for each.
   */
  const challenges = useAsync(() => challengesApi.getChallenges(), [])
  const [tab, setTab] = useState<ChallengeState>('active')

  const shown = challenges.data?.[tab] ?? []

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
        {/*
          No "Host a challenge" button. Creating one is an administrator
          action — `POST /api/challenges`, gated on `auth.User.isAdmin` — and
          there is no admin surface in the reader-facing app to put it behind,
          so the button did nothing but promise something. Hosting is done
          through the API today; see the README.
        */}
      </header>

      <div className="page-tabs">
        <Tabs
          items={TABS.map((item) => ({
            ...item,
            count: challenges.data?.[item.id].length,
          }))}
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
            title={`No ${tab === 'past' ? 'past' : tab} challenges`}
            description={EMPTY_COPY[tab]}
          />
        ) : (
          <div className="card-grid">
            {shown.map((challenge) => (
              <Link
                key={challenge.id}
                to={`/challenges/${challenge.slug}`}
                className="card-link"
              >
                <ChallengeCard challenge={challenge} />
              </Link>
            ))}
          </div>
        )}
      </TabPanel>
    </AppShell>
  )
}
