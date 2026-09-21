import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  DEFAULT_READER_PREFERENCES,
  READER_PREFS_VERSION,
  READER_STORAGE_KEY,
  ReaderPrefsContext,
  migrateStoredPreferences,
  type ReaderPreferences,
  type StoredReaderPreferences,
} from '../../lib/reader-prefs'

/**
 * Reads the stored preferences, migrated to the current version.
 *
 * Pure: it never writes, so it is safe to call from a `useState` initialiser
 * that React may run twice. Whether the migration changed anything is reported
 * separately, because that is the only case the provider has to persist.
 */
function readStored(): { preferences: ReaderPreferences; migrated: boolean } {
  try {
    const raw = localStorage.getItem(READER_STORAGE_KEY)
    if (!raw) return { preferences: DEFAULT_READER_PREFERENCES, migrated: false }

    const stored = JSON.parse(raw) as StoredReaderPreferences
    const merged = { ...DEFAULT_READER_PREFERENCES, ...stored }
    const migrated = migrateStoredPreferences(merged)

    return { preferences: migrated, migrated: migrated !== merged }
  } catch {
    // Private mode, blocked storage, or a blob from a build that wrote
    // something this one cannot parse. The defaults are always valid.
    return { preferences: DEFAULT_READER_PREFERENCES, migrated: false }
  }
}

export function ReaderPrefsProvider({ children }: { children: ReactNode }) {
  const initial = useRef(readStored())
  const [preferences, setPreferences] = useState<ReaderPreferences>(
    initial.current.preferences,
  )

  const persist = useCallback((next: ReaderPreferences) => {
    try {
      // Stamped on every write, so a preference saved by this build is never
      // migrated again.
      const stored: StoredReaderPreferences = {
        ...next,
        version: READER_PREFS_VERSION,
      }
      localStorage.setItem(READER_STORAGE_KEY, JSON.stringify(stored))
    } catch {
      // Non-fatal — preferences apply for this session only.
    }
  }, [])

  /**
   * Writes a migrated blob back once, on mount.
   *
   * In an effect rather than in `readStored` because a `useState` initialiser
   * must not have side effects — React is free to run it twice, and in
   * StrictMode it does. Skipping the write entirely would work too, since the
   * migration is deterministic and would simply run again next load; doing it
   * here means the old value stops being re-examined, which is what makes a
   * later deliberate choice of Sepia stick.
   */
  useEffect(() => {
    if (initial.current.migrated) persist(initial.current.preferences)
  }, [persist])

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
