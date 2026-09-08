/**
 * Chart palette.
 *
 * Light and dark are *selected* steps, not an automatic flip, and each pair was
 * checked against its own surface with the palette validator:
 *
 *   light (#ffffff surface): #a2431b / #1a63b8 — CVD ΔE 23.5 protan, 27.5 normal
 *   dark  (#1e1a18 surface): #d9762f / #3f88de — CVD ΔE 24.8 protan, 29.5 normal
 *
 * Both pass the lightness band, chroma floor, CVD separation, normal-vision
 * floor and 3:1 contrast checks. Categorical hues are assigned in fixed order
 * and never cycled.
 */

export interface ChartTheme {
  series: [string, string]
  /** Single hue for one-series magnitude (the rating breakdown). */
  sequential: string
  grid: string
  axis: string
}

export const CHART_LIGHT: ChartTheme = {
  series: ['#a2431b', '#1a63b8'],
  sequential: '#a2431b',
  grid: 'rgba(28, 24, 21, 0.09)',
  axis: 'rgba(28, 24, 21, 0.28)',
}

export const CHART_DARK: ChartTheme = {
  series: ['#d9762f', '#3f88de'],
  sequential: '#d9762f',
  grid: 'rgba(241, 237, 230, 0.11)',
  axis: 'rgba(241, 237, 230, 0.3)',
}

export function chartTheme(resolved: 'light' | 'dark'): ChartTheme {
  return resolved === 'dark' ? CHART_DARK : CHART_LIGHT
}
