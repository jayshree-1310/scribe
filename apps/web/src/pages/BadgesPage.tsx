import { useState } from 'react'
import { useAsync } from '../hooks/useAsync'
import { getBadges } from '../data/gamification-api'
import type { BadgeCategory, LevelProgress } from '../types/gamification'
import { SectionHead, StatTile } from '../components/ui/Card'
import { ProgressBar } from '../components/ui/Progress'
import { Skeleton } from '../components/ui/Skeleton'
import { Tabs, TabPanel } from '../components/ui/Tabs'
import { EmptyState, ErrorState } from '../components/ui/States'
import { BadgeTile } from '../components/story/Cards'
import './pages.css'

type Filter = 'all' | BadgeCategory

const TABS = [
  { id: 'all' as const, label: 'All' },
  { id: 'reading' as const, label: 'Reading' },
  { id: 'writing' as const, label: 'Writing' },
  { id: 'community' as const, label: 'Community' },
]

/** One level meter: where the reader is, and what the next step costs. */
function LevelMeter({
  title,
  level,
  unit,
}: {
  title: string
  level: LevelProgress
  unit: string
}) {
  return (
    <div className="badges__overall">
      <div className="badges__overall-head">
        <span>{title}</span>
        <strong>Level {level.level}</strong>
      </div>
      <ProgressBar value={level.progress} size="md" label={`${title} progress`} />
      <p className="badges__overall-foot">
        {level.next === null
          ? `${level.value.toLocaleString()} ${unit} — top level`
          : `${level.value.toLocaleString()} of ${level.next.toLocaleString()} ${unit} to level ${level.level + 1}`}
      </p>
    </div>
  )
}

/**
 * The badges page no longer announces anything.
 *
 * It used to diff the earned list against what this browser had already shown
 * and toast the difference, because a badge is awarded by whichever event
 * moved its metric and the reader is almost never here when that happens. The
 * server now says so itself, as a `BADGE_EARNED` notification in the bell —
 * which reaches them wherever they are, on every device, rather than only on
 * the next visit to this page in this browser. Keeping the toast as well would
 * announce every badge twice.
 */
export function BadgesPage() {
  const collection = useAsync(() => getBadges(), [])
  const [filter, setFilter] = useState<Filter>('all')

  const all = collection.data?.badges ?? []
  const earned = all.filter((entry) => entry.earned)

  const shown =
    filter === 'all' ? all : all.filter((entry) => entry.badge.category === filter)

  const earnedShown = shown.filter((entry) => entry.earned)
  const lockedShown = shown.filter((entry) => !entry.earned)
  const completion = all.length === 0 ? 0 : earned.length / all.length
  const levels = collection.data?.levels

  return (
    <>
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

      <div className="badges__meters">
        <div className="badges__overall">
          <div className="badges__overall-head">
            <span>Collection progress</span>
            <strong>
              {earned.length}/{all.length}
            </strong>
          </div>
          <ProgressBar value={completion} size="md" label="Badge collection progress" />
          <p className="badges__overall-foot">
            {all.length - earned.length} still to unlock
          </p>
        </div>

        {levels ? (
          <>
            <LevelMeter title="Reader level" level={levels.reader} unit="chapters read" />
            <LevelMeter title="Author level" level={levels.author} unit="words written" />
          </>
        ) : null}
      </div>

      <div className="page-tabs">
        <Tabs items={TABS} active={filter} onChange={setFilter} label="Badge categories" />
      </div>

      <TabPanel id={filter}>
        {collection.status === 'error' ? (
          <ErrorState message={collection.error} onRetry={collection.reload} />
        ) : collection.status === 'loading' ? (
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
                    <BadgeTile key={entry.badge.code} entry={entry} />
                  ))}
                </div>
              )}
            </section>

            <section className="page-section">
              <SectionHead title="Locked" subtitle={`${lockedShown.length} to go`} />
              {lockedShown.length === 0 ? (
                <EmptyState
                  size="sm"
                  icon="check-circle"
                  title="Every badge in this category is yours"
                />
              ) : (
                <div className="card-grid card-grid--tight">
                  {lockedShown.map((entry) => (
                    <BadgeTile key={entry.badge.code} entry={entry} />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </TabPanel>
    </>
  )
}
