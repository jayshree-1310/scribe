/**
 * Generated cover art.
 *
 * Scribe has no uploaded artwork yet, and stock imagery would misrepresent the
 * product, so covers are composed from the story's own data: the primary
 * genre's hue picks the palette and the id picks one of a few spine/panel
 * treatments. The result is deterministic — a story always looks the same.
 */

export interface CoverArt {
  /** Background for the cover face. */
  background: string
  /** Colour for the title and author text. */
  ink: string
  /** Decorative rule/pattern colour. */
  accent: string
  /** One of four layout treatments. */
  variant: 1 | 2 | 3 | 4
}

function hashOf(seed: string): number {
  let hash = 5381
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 33) ^ seed.charCodeAt(index)
  }
  return Math.abs(hash)
}

export function coverArt(seed: string, hue: number): CoverArt {
  const hash = hashOf(seed)
  const variant = ((hash % 4) + 1) as CoverArt['variant']
  const drift = (hash % 26) - 13
  const second = (hue + 34 + drift + 360) % 360

  const dark = `hsl(${hue} 46% 21%)`
  const mid = `hsl(${second} 40% 34%)`
  const deep = `hsl(${hue} 52% 14%)`

  const background =
    variant === 1
      ? `linear-gradient(150deg, ${mid} 0%, ${dark} 58%, ${deep} 100%)`
      : variant === 2
        ? `radial-gradient(120% 90% at 22% 12%, ${mid} 0%, ${dark} 52%, ${deep} 100%)`
        : variant === 3
          ? `linear-gradient(190deg, ${dark} 0%, ${deep} 46%, ${mid} 100%)`
          : `conic-gradient(from 210deg at 76% 18%, ${mid} 0deg, ${dark} 150deg, ${deep} 300deg, ${mid} 360deg)`

  return {
    background,
    ink: `hsl(${hue} 34% 95%)`,
    accent: `hsl(${second} 62% 72%)`,
    variant,
  }
}

/** Soft tint used behind a story's detail header. */
/**
 * A stable hue for anything that has no hue of its own — an account from the
 * API, which has no `avatarHue` column. Deterministic per seed, so a person's
 * monogram is the same colour everywhere it appears.
 */
export function hueFor(seed: string): number {
  return hashOf(seed) % 360
}

export function coverWash(hue: number): string {
  return `linear-gradient(180deg, hsl(${hue} 40% 30% / 0.55) 0%, hsl(${hue} 34% 18% / 0.18) 62%, transparent 100%)`
}

/** Chip colours for a genre, readable in both themes. */
export function genreChipStyle(hue: number): Record<string, string> {
  return {
    '--chip-bg': `hsl(${hue} 62% 94%)`,
    '--chip-fg': `hsl(${hue} 58% 26%)`,
    '--chip-border': `hsl(${hue} 46% 82%)`,
    '--chip-bg-dark': `hsl(${hue} 34% 18%)`,
    '--chip-fg-dark': `hsl(${hue} 70% 82%)`,
    '--chip-border-dark': `hsl(${hue} 30% 30%)`,
  }
}
