/**
 * Reading preferences for the immersive reader, persisted per browser and
 * also editable from Settings → Reading.
 */

import { createContext, useContext } from 'react'

export const READER_STORAGE_KEY = 'scribe:reader'

/**
 * The shape version of what is in `localStorage`.
 *
 * Bumped when a *default* changes in a way a stored value would hide. Version
 * 1 had no marker at all and defaulted `theme` to `'sepia'`, so every reader
 * who ever touched the font size has a frozen `'sepia'` that predates `auto`
 * existing — and Sepia looks the same whichever way the app theme goes, which
 * is precisely the bug `auto` was added to fix. Without a migration the new
 * default would only ever reach a browser that had never opened the reader.
 */
export const READER_PREFS_VERSION = 2

/**
 * What a reader can choose, which is not the same as what gets drawn.
 *
 * `auto` is a *preference*, not a surface: it means "whatever Scribe is
 * wearing". The three below it are standing choices that hold whatever the app
 * theme does — somebody who reads on Sepia wants Sepia at midnight too.
 *
 * `auto` is first because it is the default, and the default matters: a reader
 * who has never opened this control used to get cream paper inside a dark app,
 * which reads as a bug rather than as a choice nobody made.
 */
export const READING_THEMES = ['auto', 'light', 'sepia', 'dark'] as const
export type ReadingTheme = (typeof READING_THEMES)[number]

/**
 * What `reader.css` actually styles: the three real surfaces, with `auto`
 * already resolved away. Separate from `ReadingTheme` so that
 * `data-reading-theme` cannot be handed a value no rule matches.
 */
export const READING_SURFACES = ['light', 'sepia', 'dark'] as const
export type ReadingSurface = (typeof READING_SURFACES)[number]

export const FONT_SIZES = ['sm', 'md', 'lg', 'xl'] as const
export type FontSize = (typeof FONT_SIZES)[number]

export const READING_WIDTHS = ['narrow', 'medium', 'wide'] as const
export type ReadingWidth = (typeof READING_WIDTHS)[number]

export interface ReaderPreferences {
  theme: ReadingTheme
  fontSize: FontSize
  width: ReadingWidth
  autoplayMultimedia: boolean
}

/** What is actually written to storage: the preferences plus their version. */
export interface StoredReaderPreferences extends ReaderPreferences {
  version?: number
}

/**
 * Brings a stored blob up to the current version.
 *
 * **Only `'sepia'` is rewritten, and only once.** The pre-`auto` default was
 * exactly `'sepia'`, so that is the one value that cannot be told apart from a
 * choice nobody made; `'light'` and `'dark'` were never defaults, so a stored
 * one of those is a deliberate standing choice and is left alone. A reader who
 * genuinely wants Sepia picks it again — and because the version is stamped on
 * the way out, that second choice is never revisited.
 *
 * Returns the unchanged object when there is nothing to do, so the caller can
 * tell a migration happened by identity and only write when it did.
 */
export function migrateStoredPreferences(
  stored: StoredReaderPreferences,
): StoredReaderPreferences {
  if (stored.version === READER_PREFS_VERSION) return stored

  return {
    ...stored,
    theme: stored.theme === 'sepia' ? 'auto' : stored.theme,
    version: READER_PREFS_VERSION,
  }
}

export const DEFAULT_READER_PREFERENCES: ReaderPreferences = {
  theme: 'auto',
  fontSize: 'md',
  width: 'medium',
  autoplayMultimedia: false,
}

export interface ReaderPrefsContextValue {
  preferences: ReaderPreferences
  update: (patch: Partial<ReaderPreferences>) => void
  reset: () => void
}

export const ReaderPrefsContext = createContext<ReaderPrefsContextValue | null>(null)

export function useReaderPrefs(): ReaderPrefsContextValue {
  const context = useContext(ReaderPrefsContext)
  if (!context) {
    throw new Error('useReaderPrefs must be used inside <ReaderPrefsProvider>.')
  }
  return context
}

export const FONT_SIZE_LABELS: Record<FontSize, string> = {
  sm: 'Small',
  md: 'Medium',
  lg: 'Large',
  xl: 'Extra large',
}

export const READING_WIDTH_LABELS: Record<ReadingWidth, string> = {
  narrow: 'Narrow',
  medium: 'Comfortable',
  wide: 'Wide',
}

export const READING_THEME_LABELS: Record<ReadingTheme, string> = {
  auto: 'Match app',
  light: 'Paper',
  sepia: 'Sepia',
  dark: 'Night',
}

/**
 * The surface to draw, given the reader's choice and the app's resolved theme.
 *
 * `auto` maps to Paper rather than Sepia in a light app: Sepia is a deliberate
 * warm cream, and a reader who never asked for it should get the surface that
 * matches the pages either side of the reader rather than one that announces
 * itself.
 *
 * The app theme is passed in rather than read here so this stays a pure
 * function — `useTheme` has already resolved `system` against the OS, and
 * resolving it twice is how the two could disagree for a frame.
 */
export function resolveReadingTheme(
  theme: ReadingTheme,
  appTheme: 'light' | 'dark',
): ReadingSurface {
  if (theme !== 'auto') return theme

  return appTheme === 'dark' ? 'dark' : 'light'
}
