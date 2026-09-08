import { useState } from 'react'
import { useAsync } from '../hooks/useAsync'
import * as api from '../data/api'
import type { Badge } from '../types/domain'
import { AppShell } from '../components/layout/AppShell'
import { SectionHead, StatTile } from '../components/ui/Card'
import { ProgressBar } from '../components/ui/Progress'
import { Skeleton } from '../components/ui/Skeleton'
import { Tabs, TabPanel } from '../components/ui/Tabs'
import { EmptyState, ErrorState } from '../components/ui/States'
import { BadgeTile } from '../components/story/Cards'
import './pages.css'

type Filter = 'all' | Badge['category']

const TABS = [
  { id: 'all' as const, label: 'All' },
  { id: 'reading' as const, label: 'Reading' },
  { id: 'writing' as const, label: 'Writing' },
  { id: 'community' as const, label: 'Community' },
]

export function BadgesPage() {
  const badges = useAsync(() => api.getBadges(), [])
  const [filter, setFilter] = useState<Filter>('all')

  const all = badges.data ?? []
  const earned = all.filter((entry) => entry.earned)
  const shown =
    filter === 'all' ? all : all.filter((entry) => entry.badge.category === filter)

  const earnedShown = shown.filter((entry) => entry.earned)
  const lockedShown = shown.filter((entry) => !entry.earned)
  const completion = all.length === 0 ? 0 : earned.length / all.length

  return (
    <AppShell>
      <header className="page-head">
        <div>
          <h1 className="page-head__title">Badges</h1>
          <p className="page-head__sub">
            Small proof that you read the long one, finished the hard thing, and
            showed up for the club every week.
          </p>
        </div>
      </header>

      <div className="stat-row">
        <StatTile label="Earned" value={`${earned.length} of ${all.length}`} icon="medal" />
        <StatTile
          label="Gold badges"
          value={String(earned.filter((entry) => entry.badge.tier === 'gold').length)}
          icon="crown"
        />
        <StatTile
          label="In progress"
          value={String(all.filter((entry) => !entry.earned && entry.progress > 0).length)}
          icon="trend"
        />
        <StatTile label="Completion" value={`${Math.round(completion * 100)}%`} icon="target" />
      </div>

      <div className="badges__overall">
        <div className="badges__overall-head">
          <span>Collection progress</span>
          <strong>
            {earned.length}/{all.length}
          </strong>
        </div>
        <ProgressBar value={completion} size="md" label="Badge collection progress" />
      </div>

      <div className="page-tabs">
        <Tabs items={TABS} active={filter} onChange={setFilter} label="Badge categories" />
      </div>

      <TabPanel id={filter}>
        {badges.status === 'error' ? (
          <ErrorState message={badges.error} onRetry={badges.reload} />
        ) : badges.status === 'loading' ? (
          <div className="card-grid card-grid--tight">
            {Array.from({ length: 8 }, (_, index) => (
              <Skeleton key={index} height="12rem" radius="var(--radius-lg)" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <EmptyState icon="medal" title="No badges in this category yet" />
        ) : (
          <>
            <section className="page-section">
              <SectionHead title="Earned" subtitle={`${earnedShown.length} unlocked`} />
              {earnedShown.length === 0 ? (
                <EmptyState
                  size="sm"
                  icon="medal"
                  title="Nothing earned here yet"
                  description="Keep reading and writing — these unlock as you go."
                />
              ) : (
                <div className="card-grid card-grid--tight">
                  {earnedShown.map((entry) => (
                    <BadgeTile key={entry.badge.id} entry={entry} />
                  ))}
                </div>
              )}
            </section>

            <section className="page-section">
              <SectionHead title="Locked" subtitle={`${lockedShown.length} to go`} />
              <div className="card-grid card-grid--tight">
                {lockedShown.map((entry) => (
                  <BadgeTile key={entry.badge.id} entry={entry} />
                ))}
              </div>
            </section>
          </>
        )}
      </TabPanel>
    </AppShell>
  )
}
