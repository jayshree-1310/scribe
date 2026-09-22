import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAsync } from '../hooks/useAsync'
import { useAuth } from '../lib/auth'
import { useToast } from '../lib/toast'
import * as challengesApi from '../data/challenges-api'
import type { ChallengeState } from '../types/challenges'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { Skeleton } from '../components/ui/Skeleton'
import { Tabs, TabPanel } from '../components/ui/Tabs'
import { EmptyState, ErrorState } from '../components/ui/States'
import { ChallengeCard } from '../components/story/Cards'
import { ChallengeHostDialog } from '../components/challenges/ChallengeHostDialog'
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
  const { session } = useAuth()
  const { showToast } = useToast()

  /** Bumped after hosting one, to re-read the three groups it belongs to. */
  const [revision, setRevision] = useState(0)
  const challenges = useAsync(() => challengesApi.getChallenges(), [revision])
  const [tab, setTab] = useState<ChallengeState>('active')
  const [hosting, setHosting] = useState(false)

  const shown = challenges.data?.[tab] ?? []

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-head__title">Writing challenges</h1>
          <p className="page-head__sub">
            A prompt, a deadline, and a few thousand people writing to the same
            brief. The fastest way to finish something.
          </p>
        </div>
        {/*
          Offered only to administrators, which is what `POST /api/challenges`
          has always required. The button used not to exist at all because
          nothing in the app knew who was one; `AccountProfile.isAdmin` is what
          changed. The endpoint still checks for itself.
        */}
        {session?.user.isAdmin ? (
          <Button
            variant="primary"
            onClick={() => setHosting(true)}
            startIcon={<Icon name="plus" />}
          >
            Host a challenge
          </Button>
        ) : null}
      </header>

      {hosting ? (
        <ChallengeHostDialog
          onClose={() => setHosting(false)}
          onSaved={(challenge) => {
            setHosting(false)
            showToast({ tone: 'success', message: `"${challenge.title}" is live.` })
            // Which group it lands in depends on its window against the clock,
            // so the board is re-read rather than guessed at.
            setRevision((current) => current + 1)
          }}
        />
      ) : null}

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
    </>
  )
}
