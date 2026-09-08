/**
 * Theme preference: light, dark, or follow the system.
 *
 * The resolved value is stamped on `<html data-theme>` so the whole stylesheet
 * switches at once. `index.html` applies the stored value before first paint,
 * which is why there is no flash of the wrong theme on load.
 */

import { createContext, useContext } from 'react'

export const THEME_STORAGE_KEY = 'scribe:theme'

export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const
export type ThemePreference = (typeof THEME_PREFERENCES)[number]
export type ResolvedTheme = 'light' | 'dark'

export interface ThemeContextValue {
  preference: ThemePreference
  resolved: ResolvedTheme
  setPreference: (preference: ThemePreference) => void
  /** Flips between light and dark, leaving `system` behind. */
  toggle: () => void
}

export const ThemeContext = createContext<ThemeContextValue | null>(null)

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme must be used inside <ThemeProvider>.')
  return context
}

export function readStoredPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    if (stored && (THEME_PREFERENCES as readonly string[]).includes(stored)) {
      return stored as ThemePreference
    }
  } catch {
    // Private mode or blocked storage: fall back to following the system.
  }
  return 'system'
}

export function systemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? systemTheme() : preference
}
