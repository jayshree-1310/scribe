/**
 * Reading preferences for the immersive reader, persisted per browser and
 * also editable from Settings → Reading.
 */

import { createContext, useContext } from 'react'

export const READER_STORAGE_KEY = 'scribe:reader'

export const READING_THEMES = ['light', 'sepia', 'dark'] as const
export type ReadingTheme = (typeof READING_THEMES)[number]

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

export const DEFAULT_READER_PREFERENCES: ReaderPreferences = {
  theme: 'sepia',
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
  light: 'Paper',
  sepia: 'Sepia',
  dark: 'Night',
}
