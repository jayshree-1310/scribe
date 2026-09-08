import { useTheme } from '../../lib/theme'
import { formatCount } from '../../lib/format'
import { chartTheme } from './palette'
import './charts.css'

interface RatingBarsProps {
  /** Count of ratings keyed by score, 1–5. */
  breakdown: Record<number, number>
  total: number
}

/**
 * One ordered series, so magnitude is carried by bar length in a single hue —
 * not by a categorical palette. Counts are labelled directly, so the chart
 * never depends on colour or hover to be read.
 */
export function RatingBars({ breakdown, total }: RatingBarsProps) {
  const { resolved } = useTheme()
  const theme = chartTheme(resolved)
  const peak = Math.max(1, ...Object.values(breakdown))

  return (
    <ul className="rating-bars">
      {[5, 4, 3, 2, 1].map((score) => {
        const count = breakdown[score] ?? 0
        const share = total === 0 ? 0 : count / total

        return (
          <li className="rating-bars__row" key={score}>
            <span className="rating-bars__score">
              {score}
              <span className="visually-hidden"> star{score === 1 ? '' : 's'}</span>
            </span>

            <span className="rating-bars__track">
              <span
                className="rating-bars__fill"
                style={{
                  width: `${(count / peak) * 100}%`,
                  background: theme.sequential,
                }}
              />
            </span>

            <span className="rating-bars__count">
              {formatCount(count)}
              <span className="rating-bars__share">{Math.round(share * 100)}%</span>
            </span>
          </li>
        )
      })}
    </ul>
  )
}
