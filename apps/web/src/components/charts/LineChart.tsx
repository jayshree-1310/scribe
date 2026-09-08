import { useState } from 'react'
import { useTheme } from '../../lib/theme'
import { formatCount, formatMonthDay } from '../../lib/format'
import { useElementWidth } from '../../hooks/useElementWidth'
import { chartTheme } from './palette'
import './charts.css'

export interface LinePoint {
  date: string
  views: number
  reads: number
}

interface LineChartProps {
  data: LinePoint[]
  /** Names the two series; also used by the legend and end labels. */
  seriesLabels?: [string, string]
  height?: number
  title: string
}

const PADDING = { top: 16, right: 56, bottom: 26, left: 44 }

function niceCeiling(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(value, 1)))
  return Math.ceil(value / magnitude) * magnitude
}

/**
 * Two same-unit series on one axis (never a second y-scale). Ships with a
 * crosshair + tooltip, a legend, direct end labels so identity is not carried
 * by colour alone, and an equivalent table for assistive tech.
 */
export function LineChart({
  data,
  seriesLabels = ['Views', 'Reads'],
  height = 240,
  title,
}: LineChartProps) {
  const [wrapRef, width] = useElementWidth<HTMLDivElement>()
  const { resolved } = useTheme()
  const theme = chartTheme(resolved)
  const [hover, setHover] = useState<number | null>(null)

  const plotWidth = Math.max(0, width - PADDING.left - PADDING.right)
  const plotHeight = height - PADDING.top - PADDING.bottom

  const max = niceCeiling(
    data.reduce((peak, point) => Math.max(peak, point.views, point.reads), 0),
  )

  const x = (index: number) =>
    PADDING.left + (data.length <= 1 ? 0 : (index / (data.length - 1)) * plotWidth)
  const y = (value: number) => PADDING.top + plotHeight - (value / max) * plotHeight

  const path = (key: 'views' | 'reads') =>
    data.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index)} ${y(point[key])}`).join(' ')

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => Math.round(max * fraction))
  const xTickIndexes = [0, Math.floor((data.length - 1) / 2), data.length - 1]

  function onPointerMove(event: React.PointerEvent<SVGSVGElement>) {
    if (plotWidth <= 0 || data.length === 0) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const offset = event.clientX - bounds.left - PADDING.left
    const ratio = Math.max(0, Math.min(1, offset / plotWidth))
    setHover(Math.round(ratio * (data.length - 1)))
  }

  const active = hover === null ? null : data[hover]

  return (
    <figure className="chart" ref={wrapRef}>
      <figcaption className="chart__legend">
        {seriesLabels.map((label, index) => (
          <span className="chart__legend-item" key={label}>
            <span
              className="chart__swatch"
              style={{ background: theme.series[index] }}
              aria-hidden="true"
            />
            {label}
          </span>
        ))}
      </figcaption>

      {width > 0 ? (
        <div className="chart__plot">
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={title}
            onPointerMove={onPointerMove}
            onPointerLeave={() => setHover(null)}
          >
            {/* Recessive grid */}
            {ticks.map((tick) => (
              <g key={tick}>
                <line
                  x1={PADDING.left}
                  x2={PADDING.left + plotWidth}
                  y1={y(tick)}
                  y2={y(tick)}
                  stroke={theme.grid}
                  strokeWidth={1}
                />
                <text className="chart__tick" x={PADDING.left - 8} y={y(tick) + 4} textAnchor="end">
                  {formatCount(tick)}
                </text>
              </g>
            ))}

            {xTickIndexes.map((index) => {
              const point = data[index]
              return point ? (
                <text
                  key={point.date}
                  className="chart__tick"
                  x={x(index)}
                  y={height - 6}
                  textAnchor={index === 0 ? 'start' : index === data.length - 1 ? 'end' : 'middle'}
                >
                  {formatMonthDay(point.date)}
                </text>
              ) : null
            })}

            {/* Area under the primary series, then both lines at 2px */}
            <path
              d={`${path('views')} L${x(data.length - 1)} ${y(0)} L${x(0)} ${y(0)} Z`}
              fill={theme.series[0]}
              opacity={0.09}
            />
            <path d={path('reads')} fill="none" stroke={theme.series[1]} strokeWidth={2} strokeLinecap="round" />
            <path d={path('views')} fill="none" stroke={theme.series[0]} strokeWidth={2} strokeLinecap="round" />

            {/* Direct end labels — identity without relying on colour */}
            {data.length > 0 ? (
              <>
                <text
                  className="chart__end-label"
                  x={PADDING.left + plotWidth + 8}
                  y={y(data[data.length - 1]!.views) + 4}
                >
                  {seriesLabels[0]}
                </text>
                <text
                  className="chart__end-label"
                  x={PADDING.left + plotWidth + 8}
                  y={y(data[data.length - 1]!.reads) + 4}
                >
                  {seriesLabels[1]}
                </text>
              </>
            ) : null}

            {/* Crosshair */}
            {hover !== null && active ? (
              <g aria-hidden="true">
                <line
                  x1={x(hover)}
                  x2={x(hover)}
                  y1={PADDING.top}
                  y2={PADDING.top + plotHeight}
                  stroke={theme.axis}
                  strokeWidth={1}
                  strokeDasharray="3 3"
                />
                <circle cx={x(hover)} cy={y(active.views)} r={4.5} fill={theme.series[0]} stroke="var(--surface)" strokeWidth={2} />
                <circle cx={x(hover)} cy={y(active.reads)} r={4.5} fill={theme.series[1]} stroke="var(--surface)" strokeWidth={2} />
              </g>
            ) : null}
          </svg>

          {hover !== null && active ? (
            <div
              className="chart__tooltip"
              style={{
                left: `${Math.min(Math.max(x(hover), 72), width - 72)}px`,
              }}
              role="status"
            >
              <p className="chart__tooltip-date">{formatMonthDay(active.date)}</p>
              <p>
                <span className="chart__swatch" style={{ background: theme.series[0] }} />
                {seriesLabels[0]} <strong>{formatCount(active.views)}</strong>
              </p>
              <p>
                <span className="chart__swatch" style={{ background: theme.series[1] }} />
                {seriesLabels[1]} <strong>{formatCount(active.reads)}</strong>
              </p>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="chart__plot" style={{ height }} />
      )}

      {/* Equivalent table so the data is never colour- or hover-only. */}
      <details className="chart__table">
        <summary>View as table</summary>
        <table>
          <caption className="visually-hidden">{title}</caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">{seriesLabels[0]}</th>
              <th scope="col">{seriesLabels[1]}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((point) => (
              <tr key={point.date}>
                <th scope="row">{formatMonthDay(point.date)}</th>
                <td>{formatCount(point.views)}</td>
                <td>{formatCount(point.reads)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  )
}
