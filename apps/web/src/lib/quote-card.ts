/**
 * Quote cards: a highlighted passage drawn as a square image to share.
 *
 * Drawn in the browser on a `<canvas>`, so no server renders anything and
 * nothing about the passage leaves the reader's device until they share the
 * image themselves. The card prints the passage, the story's cover, title and
 * author, the chapter, and the address of that chapter; the share link that
 * goes with it opens the same chapter (`quoteCardLink`).
 *
 * Text layout is kept apart from the canvas (`cardParagraphs`, `wrapText`,
 * `fitQuote` take a measuring function), so it can be tested without one.
 */

import { withoutMediaTokens } from './chapter-media'
import { coverPalette } from './cover'

/** The card is square, the shape every place people share images takes. */
export const CARD_SIZE = 1080

export type QuoteCardStyle = 'violet' | 'paper'

export const QUOTE_CARD_STYLES: Array<{ value: QuoteCardStyle; label: string }> = [
  { value: 'violet', label: 'Violet' },
  { value: 'paper', label: 'Paper' },
]

export interface QuoteCardInput {
  /** The passage as stored: chapter source, emphasis markers included. */
  quote: string
  storyId: string
  storyTitle: string
  authorName: string
  coverUrl: string | null
  /** The primary genre's hue, which a generated cover is drawn in. */
  hue: number
  chapterNumber: number
  chapterTitle: string
  /** The chapter's address as printed on the card (`quoteCardAddress`). */
  address: string
  style: QuoteCardStyle
}

export interface QuoteCard {
  blob: Blob
  /** The passage was too long for the card, which shows its beginning. */
  truncated: boolean
}

/* Text ------------------------------------------------------------------- */

/**
 * The passage as the reader saw it, one entry per block.
 *
 * The renderer (`lib/chapter-markdown.tsx`) makes every source line a block
 * and gives a handful of line prefixes meaning, so each line is a paragraph
 * here with those prefixes, the emphasis markers and any attachment token
 * dropped. A line that was nothing but markup (a `* * *` scene break) goes
 * with them.
 */
export function cardParagraphs(quote: string): string[] {
  return withoutMediaTokens(quote)
    .split('\n')
    .map((line) =>
      line
        .trim()
        .replace(/^(?:#{1,2}|>|-)\s+/, '')
        .replace(/\*/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((line) => line.length > 0)
}

/** Width of `text` when drawn at `size` pixels. */
export type Measure = (text: string, size: number) => number

/**
 * Greedy word wrap. A word wider than the line on its own (a long address,
 * say) is broken between characters rather than left to overflow the card.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  measure: (text: string) => number,
): string[] {
  const lines: string[] = []
  let line = ''

  for (const word of text.split(' ').filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word
    if (measure(candidate) <= maxWidth) {
      line = candidate
      continue
    }

    if (line) lines.push(line)

    if (measure(word) <= maxWidth) {
      line = word
      continue
    }

    line = ''
    for (const character of word) {
      if (line && measure(line + character) > maxWidth) {
        lines.push(line)
        line = ''
      }
      line += character
    }
  }

  if (line) lines.push(line)
  return lines
}

/**
 * `text`, shortened at a word with an ellipsis until it fits, for one-line
 * fields: a chapter title, an address.
 */
export function ellipsize(
  text: string,
  maxWidth: number,
  measure: (text: string) => number,
): string {
  if (measure(text) <= maxWidth) return text

  const words = text.split(' ')
  while (words.length > 1) {
    words.pop()
    const shorter = `${words.join(' ').replace(/[\s,;:.–—-]+$/, '')}…`
    if (measure(shorter) <= maxWidth) return shorter
  }

  // One word too long for the line: cut it between characters.
  let cut = [...text]
  while (cut.length > 1 && measure(`${cut.join('')}…`) > maxWidth) cut = cut.slice(0, -1)
  return `${cut.join('')}…`
}

export interface QuoteLayout {
  size: number
  lineHeight: number
  /** Each line with its baseline, measured from the top of the box. */
  lines: Array<{ text: string; y: number }>
  height: number
  truncated: boolean
}

export const QUOTE_SIZES = { max: 64, min: 34, step: 2 } as const

/** Line height as a multiple of the type size. */
const LEADING = 1.38

/** Space between two paragraphs, as a share of a line. */
const PARAGRAPH_GAP = 0.55

/**
 * The largest type size at which the whole passage fits the box, laid out.
 *
 * A short line gets large type and a long passage small, down to a floor that
 * still reads on a phone. Past the floor the passage is cut after the last
 * word that fits and given an ellipsis, and `truncated` says so, so the card
 * never shrinks a paragraph into grey texture and the reader is told why it
 * stops.
 */
export function fitQuote(
  paragraphs: string[],
  measure: Measure,
  box: { width: number; height: number },
): QuoteLayout {
  const layoutAt = (size: number) => {
    const lineHeight = Math.round(size * LEADING)
    const lines: Array<{ text: string; y: number }> = []
    let y = 0

    paragraphs.forEach((paragraph, index) => {
      if (index > 0) y += Math.round(lineHeight * PARAGRAPH_GAP)
      for (const text of wrapText(paragraph, box.width, (value) => measure(value, size))) {
        y += lineHeight
        lines.push({ text, y })
      }
    })

    return { size, lineHeight, lines, height: y }
  }

  for (let size = QUOTE_SIZES.max; size >= QUOTE_SIZES.min; size -= QUOTE_SIZES.step) {
    const layout = layoutAt(size)
    if (layout.height <= box.height) return { ...layout, truncated: false }
  }

  const smallest = layoutAt(QUOTE_SIZES.min)
  const kept = smallest.lines.filter((line) => line.y <= box.height)
  const last = kept.pop()
  if (!last) return { ...smallest, lines: [], height: 0, truncated: true }

  // The last line that fits, cut back until its ellipsis fits too: by word,
  // and by character only when one word fills the line.
  const fits = (value: string) => measure(`${value}…`, smallest.size) <= box.width
  let text = last.text
  while (!fits(text) && text.includes(' ')) text = text.slice(0, text.lastIndexOf(' '))
  while (!fits(text) && [...text].length > 1) text = [...text].slice(0, -1).join('')

  kept.push({ text: `${text.replace(/[\s,;:.–—-]+$/, '')}…`, y: last.y })
  return { ...smallest, lines: kept, height: last.y, truncated: true }
}

/** "Chapter 3 · The Ferry", without repeating a title that only says "Chapter 3". */
export function chapterLabel(number: number, title: string): string {
  const trimmed = title.trim()
  if (trimmed === '' || /^chapter\s+\w+$/i.test(trimmed)) return `Chapter ${number}`
  return `Chapter ${number} · ${trimmed}`
}

/** Where the share link goes: the chapter, from its first line. */
export function quoteCardLink(origin: string, slug: string, chapterNumber: number): string {
  return `${origin}/read/${encodeURIComponent(slug)}/${chapterNumber}`
}

/** The same address as printed on the card, which has no use for the scheme. */
export function quoteCardAddress(link: string): string {
  return link.replace(/^https?:\/\//, '')
}

/* Drawing ---------------------------------------------------------------- */

interface Palette {
  /** Gradient stops for the background, top-left to bottom-right. */
  background: [string, string, string]
  /** A soft brand glow from the top-left corner. */
  glow: string
  ink: string
  muted: string
  accent: string
  rule: string
  /** The logo tile and the mark on it, as the app draws them on this ground. */
  tile: string
  mark: string
  coverShadow: string
}

/** Scribe's own colours (`index.css`): the dark theme's, and the light one's. */
const PALETTES: Record<QuoteCardStyle, Palette> = {
  violet: {
    background: ['#2c2058', '#1b1436', '#110c22'],
    glow: 'rgba(106, 76, 192, 0.42)',
    ink: '#f3effc',
    muted: 'rgba(243, 239, 252, 0.7)',
    accent: '#b9a3f5',
    rule: 'rgba(185, 163, 245, 0.32)',
    tile: '#b9a3f5',
    mark: '#1c1235',
    coverShadow: 'rgba(0, 0, 0, 0.5)',
  },
  paper: {
    background: ['#fdfcff', '#f6f4fb', '#ebe7f5'],
    glow: 'rgba(106, 76, 192, 0.1)',
    ink: '#1b1922',
    muted: '#524d5f',
    accent: '#6a4cc0',
    rule: 'rgba(106, 76, 192, 0.24)',
    tile: '#6a4cc0',
    mark: '#ffffff',
    coverShadow: 'rgba(34, 27, 56, 0.3)',
  },
}

const SERIF = "Newsreader, 'Iowan Old Style', Georgia, serif"
const SANS = "Inter, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"

/** The bookmark from `ScribeMark`, in its 24-unit box. */
const MARK_PATH =
  'M6.6 4.6A1.9 1.9 0 0 1 8.5 2.7h7A1.9 1.9 0 0 1 17.4 4.6v16.1c0 .9-1 1.4-1.7.9L12 18.7l-3.7 2.9c-.7.5-1.7 0-1.7-.9z'

/* Geometry, in card pixels. */
const PAD = 96
const COVER = { width: 140, height: 210 }
const FOOTER_TOP = CARD_SIZE - PAD - COVER.height
const RULE_Y = FOOTER_TOP - 40
const QUOTE_TOP = PAD + 120
const QUOTE_BOTTOM = RULE_Y - 44

/** How long to wait for a font or the cover before drawing without it. */
const LOAD_TIMEOUT_MS = 5000

function timeout(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms))
}

/**
 * Canvas text uses a web font only once it has loaded, and silently falls
 * back otherwise. Loaded with the card's own text, so the subsets it needs
 * (Google Fonts splits by script) are the ones fetched. A font that does not
 * arrive in time leaves the fallback in the stack, which is still a card.
 */
async function loadFonts(sample: string): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts?.load) return
  const faces = [
    `400 48px ${SERIF}`,
    `600 48px ${SERIF}`,
    `500 28px ${SANS}`,
    `600 28px ${SANS}`,
  ]
  await Promise.race([
    Promise.all(faces.map((face) => document.fonts.load(face, sample))).catch(() => null),
    timeout(LOAD_TIMEOUT_MS),
  ])
}

/**
 * The uploaded cover, or null to draw the generated one.
 *
 * Asked for with CORS, because an image from another origin drawn without it
 * taints the canvas and the card could not be exported at all. A store that
 * does not answer with CORS headers fails the load instead, which lands on the
 * generated cover: the fallback `StoryCover` uses for an image that fails.
 */
function loadCover(url: string | null): Promise<HTMLImageElement | null> {
  if (!url) return Promise.resolve(null)
  const load = new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = url
  })
  return Promise.race([load, timeout(LOAD_TIMEOUT_MS)])
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath()
  context.moveTo(x + radius, y)
  context.arcTo(x + width, y, x + width, y + height, radius)
  context.arcTo(x + width, y + height, x, y + height, radius)
  context.arcTo(x, y + height, x, y, radius)
  context.arcTo(x, y, x + width, y, radius)
  context.closePath()
}

/** A CSS `linear-gradient(<angle>)` over a rectangle, as a canvas gradient. */
function angledGradient(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  degrees: number,
): CanvasGradient {
  const radians = (degrees * Math.PI) / 180
  const dx = Math.sin(radians)
  const dy = -Math.cos(radians)
  const half = (Math.abs(width * dx) + Math.abs(height * dy)) / 2
  const cx = x + width / 2
  const cy = y + height / 2
  return context.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half)
}

/**
 * The generated cover (`lib/cover.ts`, `StoryCover`) at thumbnail size: the
 * same gradient per variant, the spine, the rule, and the title and author
 * set at the foot.
 */
function drawGeneratedCover(
  context: CanvasRenderingContext2D,
  input: QuoteCardInput,
  x: number,
  y: number,
) {
  const { width, height } = COVER
  const palette = coverPalette(input.storyId, input.hue)

  let fill: CanvasGradient
  if (palette.variant === 2) {
    fill = context.createRadialGradient(x + width * 0.22, y + height * 0.12, 0, x + width * 0.22, y + height * 0.12, height)
    fill.addColorStop(0, palette.mid)
    fill.addColorStop(0.52, palette.dark)
    fill.addColorStop(1, palette.deep)
  } else if (palette.variant === 4 && typeof context.createConicGradient === 'function') {
    // CSS measures `from 210deg` clockwise from twelve o'clock; the canvas
    // measures from three o'clock.
    fill = context.createConicGradient(((210 - 90) * Math.PI) / 180, x + width * 0.76, y + height * 0.18)
    fill.addColorStop(0, palette.mid)
    fill.addColorStop(150 / 360, palette.dark)
    fill.addColorStop(300 / 360, palette.deep)
    fill.addColorStop(1, palette.mid)
  } else if (palette.variant === 3) {
    fill = angledGradient(context, x, y, width, height, 190)
    fill.addColorStop(0, palette.dark)
    fill.addColorStop(0.46, palette.deep)
    fill.addColorStop(1, palette.mid)
  } else {
    fill = angledGradient(context, x, y, width, height, 150)
    fill.addColorStop(0, palette.mid)
    fill.addColorStop(0.58, palette.dark)
    fill.addColorStop(1, palette.deep)
  }
  context.fillStyle = fill
  context.fillRect(x, y, width, height)

  const spine = context.createLinearGradient(x, 0, x + width * 0.08, 0)
  spine.addColorStop(0, 'rgba(0, 0, 0, 0.28)')
  spine.addColorStop(0.55, 'rgba(255, 255, 255, 0.13)')
  spine.addColorStop(1, 'rgba(0, 0, 0, 0.14)')
  context.fillStyle = spine
  context.fillRect(x, y, width * 0.08, height)

  const inset = width * 0.14
  const textWidth = width - inset - width * 0.08

  context.globalAlpha = 0.75
  context.fillStyle = palette.accent
  context.fillRect(x + inset, y + height * 0.62, width - inset - width * 0.12, 1.5)
  context.globalAlpha = 1

  context.fillStyle = palette.ink
  context.textBaseline = 'alphabetic'
  context.font = `600 9px ${SANS}`
  const author = ellipsize(
    input.authorName.toUpperCase(),
    textWidth,
    (text) => context.measureText(text).width,
  )
  context.globalAlpha = 0.78
  context.fillText(author, x + inset, y + height - 12)
  context.globalAlpha = 1

  context.font = `600 16px ${SERIF}`
  const measureTitle = (text: string) => context.measureText(text).width
  const title = wrapText(input.storyTitle, textWidth, measureTitle)
  const shown = title.slice(0, 4)
  if (title.length > 4) {
    shown[3] = ellipsize(title.slice(3).join(' '), textWidth, measureTitle)
  }
  shown.forEach((line, index) => {
    context.fillText(line, x + inset, y + height - 30 - (shown.length - 1 - index) * 19)
  })
}

/** Uploaded artwork, cropped to fill the frame as `StoryCover` crops it. */
function drawCoverImage(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
) {
  const { width, height } = COVER
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight)
  const sourceWidth = width / scale
  const sourceHeight = height / scale
  context.drawImage(
    image,
    (image.naturalWidth - sourceWidth) / 2,
    (image.naturalHeight - sourceHeight) / 2,
    sourceWidth,
    sourceHeight,
    x,
    y,
    width,
    height,
  )
}

function paint(
  canvas: HTMLCanvasElement,
  input: QuoteCardInput,
  cover: HTMLImageElement | null,
): boolean {
  canvas.width = CARD_SIZE
  canvas.height = CARD_SIZE
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser cannot draw the card.')

  const palette = PALETTES[input.style]
  const size = CARD_SIZE
  const width = size - PAD * 2

  /* Ground. */
  const ground = angledGradient(context, 0, 0, size, size, 135)
  ground.addColorStop(0, palette.background[0])
  ground.addColorStop(0.55, palette.background[1])
  ground.addColorStop(1, palette.background[2])
  context.fillStyle = ground
  context.fillRect(0, 0, size, size)

  const glow = context.createRadialGradient(size * 0.12, size * 0.04, 0, size * 0.12, size * 0.04, size * 0.9)
  glow.addColorStop(0, palette.glow)
  glow.addColorStop(1, 'rgba(0, 0, 0, 0)')
  context.fillStyle = glow
  context.fillRect(0, 0, size, size)

  context.textBaseline = 'alphabetic'
  context.textAlign = 'left'

  /* Opening quote mark, top left, its top on the margin. */
  context.font = `600 180px ${SERIF}`
  context.fillStyle = palette.accent
  const mark = context.measureText('“')
  context.fillText('“', PAD - 6, PAD + (mark.actualBoundingBoxAscent || 120))

  /* The Scribe lockup, top right: the bookmark tile, then the wordmark. */
  const tileSize = 56
  context.font = `600 40px ${SERIF}`
  const wordWidth = context.measureText('Scribe').width
  const tileX = size - PAD - wordWidth - 16 - tileSize
  roundedRect(context, tileX, PAD, tileSize, tileSize, 16)
  context.fillStyle = palette.tile
  context.fill()
  context.save()
  context.translate(tileX + 9, PAD + 9)
  context.scale((tileSize - 18) / 24, (tileSize - 18) / 24)
  context.fillStyle = palette.mark
  context.fill(new Path2D(MARK_PATH))
  context.restore()
  context.fillStyle = palette.ink
  context.fillText('Scribe', size - PAD - wordWidth, PAD + 41)

  /* The passage, centred in its box. */
  const box = { width, height: QUOTE_BOTTOM - QUOTE_TOP }
  const measure: Measure = (text, fontSize) => {
    context.font = `400 ${fontSize}px ${SERIF}`
    return context.measureText(text).width
  }
  const layout = fitQuote(cardParagraphs(input.quote), measure, box)
  const top = QUOTE_TOP + (box.height - layout.height) / 2
  context.font = `400 ${layout.size}px ${SERIF}`
  context.fillStyle = palette.ink
  for (const line of layout.lines) {
    // `y` is the foot of the line's box; the baseline sits a little above
    // the middle of it, which leaves the half-leading even above and below.
    context.fillText(line.text, PAD, top + line.y - layout.lineHeight / 2 + layout.size * 0.3)
  }

  /* Rule between the passage and where it is from. */
  context.fillStyle = palette.rule
  context.fillRect(PAD, RULE_Y, width, 2)

  /* The cover. */
  context.save()
  context.shadowColor = palette.coverShadow
  context.shadowBlur = 28
  context.shadowOffsetY = 10
  roundedRect(context, PAD, FOOTER_TOP, COVER.width, COVER.height, 8)
  context.fillStyle = palette.background[2]
  context.fill()
  context.restore()

  context.save()
  roundedRect(context, PAD, FOOTER_TOP, COVER.width, COVER.height, 8)
  context.clip()
  if (cover) drawCoverImage(context, cover, PAD, FOOTER_TOP)
  else drawGeneratedCover(context, input, PAD, FOOTER_TOP)
  context.restore()

  /* Title, author and chapter beside the cover; the address at its foot. */
  const textX = PAD + COVER.width + 40
  const textWidth = size - PAD - textX
  const measureWith = (font: string) => (text: string) => {
    context.font = font
    return context.measureText(text).width
  }

  const titleFont = `600 40px ${SERIF}`
  const titleLines = wrapText(input.storyTitle, textWidth, measureWith(titleFont))
  const shownTitle = titleLines.slice(0, 2)
  if (titleLines.length > 2) {
    shownTitle[1] = ellipsize(titleLines.slice(1).join(' '), textWidth, measureWith(titleFont))
  }

  let y = FOOTER_TOP + 32
  context.font = titleFont
  context.fillStyle = palette.ink
  for (const line of shownTitle) {
    context.fillText(line, textX, y)
    y += 48
  }

  const authorFont = `500 28px ${SANS}`
  y += 2
  context.font = authorFont
  context.fillStyle = palette.muted
  context.fillText(ellipsize(`by ${input.authorName}`, textWidth, measureWith(authorFont)), textX, y)

  const chapterFont = `400 26px ${SANS}`
  y += 42
  context.font = chapterFont
  context.fillText(
    ellipsize(chapterLabel(input.chapterNumber, input.chapterTitle), textWidth, measureWith(chapterFont)),
    textX,
    y,
  )

  const addressFont = `600 24px ${SANS}`
  context.font = addressFont
  context.fillStyle = palette.accent
  context.fillText(
    ellipsize(input.address, textWidth, measureWith(addressFont)),
    textX,
    FOOTER_TOP + COVER.height - 4,
  )

  return layout.truncated
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The card could not be made.'))),
      'image/png',
    )
  })
}

/** Draws the card and returns it as a PNG. */
export async function renderQuoteCard(input: QuoteCardInput): Promise<QuoteCard> {
  const [cover] = await Promise.all([
    loadCover(input.coverUrl),
    loadFonts(
      `“…·${input.quote}${input.storyTitle}${input.authorName}${input.chapterTitle}${input.address}Scribe`,
    ),
  ])

  const canvas = document.createElement('canvas')
  const truncated = paint(canvas, input, cover)
  try {
    return { blob: await toBlob(canvas), truncated }
  } catch (cause) {
    // A cover served without CORS that loaded anyway (a cached response, a
    // misconfigured store) taints the canvas, and exporting it throws. Draw
    // the generated cover instead, as if the image had failed -- on a new
    // canvas, since clearing one does not untaint it.
    if (!cover) throw cause
    const clean = document.createElement('canvas')
    paint(clean, input, null)
    return { blob: await toBlob(clean), truncated }
  }
}
