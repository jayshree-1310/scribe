import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { getSpend, type SpendLine, type SpendWindow } from '../data/ai-api'
import { Card, SectionHead } from '../components/ui/Card'
import { EmptyState, ErrorState } from '../components/ui/States'
import { Skeleton } from '../components/ui/Skeleton'
import { SegmentedControl } from '../components/ui/Tabs'
import { useAsync } from '../hooks/useAsync'
import './moderation-queue.css'
import './ai-spend.css'

/**
 * AI spend, for administrators (Task AI 18): what the model calls cost, by
 * feature, by model and by caller, read from `ai.UsageEvent`.
 *
 * Like the moderation queue, the page is *offered* when the session says
 * `isAdmin` and every request is checked again on the server. Dollars appear
 * only when the server has the provider's prices configured; otherwise the
 * page says so rather than inventing a rate.
 */

const WINDOWS = [
  { value: 1, label: 'Today' },
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
] as const satisfies ReadonlyArray<{ value: SpendWindow; label: string }>

const number = new Intl.NumberFormat()
const tokens = (line: SpendLine) => line.inputTokens + line.outputTokens
const usd = (value: number | null) =>
  value === null ? '—' : value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="spend__tile">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function SpendTable<T extends SpendLine>({
  caption,
  rows,
  name,
  priced,
}: {
  caption: string
  rows: T[]
  name: (row: T) => string
  priced: boolean
}) {
  if (rows.length === 0) return <p className="queue__sub">Nothing in this window.</p>

  return (
    <div className="spend__scroll">
      <table className="spend__table">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{caption}</th>
            <th scope="col">Calls</th>
            <th scope="col">Errors</th>
            <th scope="col">Tokens in</th>
            <th scope="col">Tokens out</th>
            <th scope="col">Cached</th>
            <th scope="col">Avg time</th>
            {priced ? <th scope="col">Cost</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={name(row)}>
              <th scope="row">{name(row)}</th>
              <td>{number.format(row.calls)}</td>
              <td>{row.errors > 0 ? number.format(row.errors) : '—'}</td>
              <td>{number.format(row.inputTokens)}</td>
              <td>{number.format(row.outputTokens)}</td>
              <td>{row.cachedTokens > 0 ? number.format(row.cachedTokens) : '—'}</td>
              <td>{number.format(row.avgDurationMs)} ms</td>
              {priced ? <td>{usd(row.costUsd)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function AiSpendPage() {
  const { session } = useAuth()
  const [days, setDays] = useState<SpendWindow>(7)
  const isAdmin = session?.user.isAdmin === true

  const report = useAsync(() => (isAdmin ? getSpend(days) : Promise.resolve(null)), [isAdmin, days])

  if (!isAdmin) {
    return (
      <EmptyState
        icon="shield"
        title="Not for you"
        description="AI spend is for administrators."
        action={<Link to="/home">Back to your feed</Link>}
      />
    )
  }

  const data = report.data

  return (
    <>
      <header className="queue__head">
        <div>
          <h1 className="queue__title">AI spend</h1>
          <p className="queue__sub">
            Every model and embedding call, by feature, model and caller.
            {data && !data.priced
              ? ' Costs are not shown: the server has no prices configured (AI_INPUT_USD_PER_MTOK, AI_OUTPUT_USD_PER_MTOK).'
              : ''}
          </p>
        </div>
        <SegmentedControl
          items={WINDOWS}
          value={days}
          onChange={(next) => setDays(next)}
          label="Window"
          size="sm"
        />
      </header>

      {report.status === 'loading' ? (
        <div className="queue__list" aria-busy="true">
          {[0, 1].map((slot) => (
            <Skeleton key={slot} height="8rem" radius="var(--radius-lg)" />
          ))}
        </div>
      ) : report.status === 'error' || !data ? (
        <ErrorState title="We couldn't load spend" message={report.error} onRetry={report.reload} />
      ) : (
        <div className="spend">
          <dl className="spend__tiles">
            <Tile label="Calls" value={number.format(data.total.calls)} />
            <Tile label="Tokens" value={number.format(tokens(data.total))} />
            <Tile label="Cached input" value={number.format(data.total.cachedTokens)} />
            <Tile label="Errors" value={number.format(data.total.errors)} />
            <Tile label="Cost" value={data.priced ? usd(data.total.costUsd) : 'Unpriced'} />
            <Tile label="Platform's own" value={number.format(tokens(data.platform))} />
          </dl>

          <Card className="spend__section">
            <SectionHead title="By feature" />
            <SpendTable
              caption="Feature"
              rows={data.byFeature}
              name={(row) => (row.kind === 'embed' ? `${row.feature} (embed)` : row.feature)}
              priced={data.priced}
            />
          </Card>

          <Card className="spend__section">
            <SectionHead title="By model" />
            <SpendTable
              caption="Model"
              rows={data.byModel}
              name={(row) => `${row.model} · ${row.provider}`}
              priced={data.priced}
            />
          </Card>

          <Card className="spend__section">
            <SectionHead
              title="Heaviest callers"
              subtitle="The ten who used the most tokens. A loop is usually a person."
            />
            <SpendTable
              caption="Caller"
              rows={data.topCallers}
              name={(row) => row.username ?? `unknown account ${row.userId.slice(0, 8)}`}
              priced={data.priced}
            />
          </Card>
        </div>
      )}
    </>
  )
}
