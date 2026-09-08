import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  DEFAULT_READER_PREFERENCES,
  READER_STORAGE_KEY,
  ReaderPrefsContext,
  type ReaderPreferences,
} from '../../lib/reader-prefs'

function readStored(): ReaderPreferences {
  try {
    const raw = localStorage.getItem(READER_STORAGE_KEY)
    if (!raw) return DEFAULT_READER_PREFERENCES
    return { ...DEFAULT_READER_PREFERENCES, ...(JSON.parse(raw) as ReaderPreferences) }
  } catch {
    return DEFAULT_READER_PREFERENCES
  }
}

export function ReaderPrefsProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<ReaderPreferences>(readStored)

  const persist = useCallback((next: ReaderPreferences) => {
    try {
      localStorage.setItem(READER_STORAGE_KEY, JSON.stringify(next))
    } catch {
      // Non-fatal — preferences apply for this session only.
    }
  }, [])

  const update = useCallback(
    (patch: Partial<ReaderPreferences>) => {
      setPreferences((current) => {
        const next = { ...current, ...patch }
        persist(next)
        return next
      })
    },
    [persist],
  )

  const reset = useCallback(() => {
    setPreferences(DEFAULT_READER_PREFERENCES)
    persist(DEFAULT_READER_PREFERENCES)
  }, [persist])

  const value = useMemo(() => ({ preferences, update, reset }), [preferences, update, reset])

  return (
    <ReaderPrefsContext.Provider value={value}>{children}</ReaderPrefsContext.Provider>
  )
}
