import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { transitionTheme } from '../../lib/motion'
import {
  THEME_STORAGE_KEY,
  ThemeContext,
  readStoredPreference,
  systemTheme,
  type ResolvedTheme,
  type ThemePreference,
} from '../../lib/theme'

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference)
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme)
  // Read by the OS listener below, which is registered once.
  const preferenceRef = useRef(preference)
  useEffect(() => {
    preferenceRef.current = preference
  }, [preference])

  // Track the OS setting so `system` stays live without a reload.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent) => {
      const next: ResolvedTheme = event.matches ? 'dark' : 'light'
      // Only fade when the page is actually following the OS.
      if (preferenceRef.current !== 'system') {
        setSystem(next)
        return
      }
      changeTheme(next, () => setSystem(next))
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  const resolved: ResolvedTheme = preference === 'system' ? system : preference

  useEffect(() => {
    document.documentElement.dataset.theme = resolved
  }, [resolved])

  const setPreference = useCallback((next: ThemePreference) => {
    changeTheme(next === 'system' ? systemTheme() : next, () => setPreferenceState(next))
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      // Storage can be unavailable; the choice still applies for this session.
    }
  }, [])

  const toggle = useCallback(() => {
    setPreference(resolved === 'dark' ? 'light' : 'dark')
  }, [resolved, setPreference])

  const value = useMemo(
    () => ({ preference, resolved, setPreference, toggle }),
    [preference, resolved, setPreference, toggle],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

/**
 * Applies a theme change as a cross-fade rather than a flip. The state update
 * is flushed and `data-theme` stamped inside the transition, so everything that
 * reads the theme -- the stylesheet and components like the charts -- lands in
 * the same frame the fade captures as its end state. The effect above stamps
 * the same value again afterwards, harmlessly.
 */
function changeTheme(nextResolved: ResolvedTheme, update: () => void) {
  const root = document.documentElement
  if (root.dataset.theme === nextResolved) {
    update()
    return
  }

  transitionTheme(() => {
    flushSync(update)
    root.dataset.theme = nextResolved
  })
}
