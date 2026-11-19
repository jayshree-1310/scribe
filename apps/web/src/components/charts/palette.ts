/**
 * Chart palette.
 *
 * Light and dark are *selected* steps, not an automatic flip, and each pair was
 * checked against its own surface with the palette validator:
 *
 *   light (#ffffff surface): #6a4cc0 / #0f7b6c
 *   dark  (#1c1a23 surface): #a68cf0 / #3fb8a3
 *
 * Violet is the brand; the second series is teal rather than the blue it used
 * to be, because violet and blue collapse into one hue for protan and deutan
 * readers. Both steps clear 3:1 against their surface. Categorical hues are
 * assigned in fixed order and never cycled.
 */

export interface ChartTheme {
  series: [string, string]
  /** Single hue for one-series magnitude (the rating breakdown). */
  sequential: string
  grid: string
  axis: string
}

export const CHART_LIGHT: ChartTheme = {
  series: ['#6a4cc0', '#0f7b6c'],
  sequential: '#6a4cc0',
  grid: 'rgba(27, 25, 34, 0.09)',
  axis: 'rgba(27, 25, 34, 0.28)',
}

export const CHART_DARK: ChartTheme = {
  series: ['#a68cf0', '#3fb8a3'],
  sequential: '#a68cf0',
  grid: 'rgba(240, 238, 246, 0.11)',
  axis: 'rgba(240, 238, 246, 0.3)',
}

export function chartTheme(resolved: 'light' | 'dark'): ChartTheme {
  return resolved === 'dark' ? CHART_DARK : CHART_LIGHT
}
