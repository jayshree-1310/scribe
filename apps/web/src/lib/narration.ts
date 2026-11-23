/**
 * Listen mode: reading a chapter aloud with the browser's own speech
 * (`speechSynthesis`), one block of the chapter at a time.
 *
 * Nothing here is sent anywhere and nothing costs anything; the voices are
 * whatever the reader's browser and operating system ship.
 *
 * Two browser behaviours shape this module, and both are worth not
 * rediscovering:
 *
 * - **Long utterances get cut off.** Chrome stops speaking a single utterance
 *   after roughly fifteen seconds with some voices, silently and without an
 *   `end` event. So a paragraph is spoken as a run of sentence-sized chunks
 *   (`speechChunks`), each its own utterance.
 * - **`pause()` and `resume()` are unreliable.** On Chrome for Linux and
 *   Android, and with network voices, `pause()` is ignored or `resume()` never
 *   resumes. So pausing *cancels* and remembers the chunk; resuming speaks that
 *   chunk again from its start. At worst a reader hears one sentence twice.
 */

/** Speeds offered in the player, as multiples of the voice's normal rate. */
export const LISTEN_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const

/**
 * The longest chunk spoken as one utterance. Comfortably inside the point at
 * which Chrome cuts a network voice off, even at 0.75×.
 */
export const MAX_CHUNK_LENGTH = 180

/** What the reader can be read: the chapter title and the prose blocks. */
const BLOCK_SELECTOR = [
  '.reader__title',
  '.reader__prose p',
  '.reader__prose h2',
  '.reader__prose h3',
  '.reader__prose blockquote',
  '.reader__prose li',
].join(', ')

/**
 * The elements to read, in reading order. An attachment's caption is part of
 * the media, not the prose, so anything inside a `figure` is left out, as is
 * a block with no words in it.
 */
export function narrationBlocks(root: ParentNode | null): HTMLElement[] {
  if (!root) return []
  return Array.from(root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)).filter(
    (element) =>
      element.closest('figure') === null &&
      (element.textContent ?? '').trim().length > 0,
  )
}

/**
 * The first block whose text is on screen, so pressing play starts where the
 * reader is looking rather than at the top of a chapter they are halfway
 * through. `top` is how much of the window the reader's top bar covers.
 */
export function firstVisibleBlock(
  blocks: readonly HTMLElement[],
  top = 0,
  bottom = typeof window === 'undefined' ? 0 : window.innerHeight,
): number {
  const index = blocks.findIndex((block) => {
    const rect = block.getBoundingClientRect()
    return rect.bottom > top && rect.top < bottom
  })
  return Math.max(0, index)
}

/**
 * Splits a block's text into chunks short enough to speak as one utterance:
 * whole sentences where possible, several short ones together, and a sentence
 * longer than `max` broken at a comma or semicolon, else at a space.
 */
export function speechChunks(text: string, max = MAX_CHUNK_LENGTH): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length === 0) return []

  // A sentence ends at . ! ? or … and any closing quotes or brackets after it.
  const sentences =
    normalized.match(/[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)\s*/g) ?? [normalized]

  const pieces: string[] = []
  for (const raw of sentences) {
    let sentence = raw.trim()
    while (sentence.length > max) {
      const window = sentence.slice(0, max)
      const pause = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '))
      const space = window.lastIndexOf(' ')
      const cut = pause > max / 3 ? pause + 1 : space > 0 ? space : max
      pieces.push(sentence.slice(0, cut).trim())
      sentence = sentence.slice(cut).trim()
    }
    if (sentence.length > 0) pieces.push(sentence)
  }

  const chunks: string[] = []
  for (const piece of pieces) {
    const last = chunks.length - 1
    if (last >= 0 && chunks[last].length + 1 + piece.length <= max) {
      chunks[last] = `${chunks[last]} ${piece}`
    } else {
      chunks.push(piece)
    }
  }
  return chunks
}

export type NarrationStatus = 'idle' | 'playing' | 'paused' | 'finished' | 'error'

export interface NarrationState {
  status: NarrationStatus
  /** The block being read, or last read. */
  index: number
  /** How many blocks there are to read. */
  total: number
}

/** The parts of `speechSynthesis` the narrator uses, so tests can fake them. */
export interface SpeechEngine {
  speak: (utterance: SpeechSynthesisUtterance) => void
  cancel: () => void
}

export interface NarratorOptions {
  engine: SpeechEngine
  makeUtterance: (text: string) => SpeechSynthesisUtterance
  /** The language to ask for when no voice is chosen. */
  lang?: string
  onChange: (state: NarrationState) => void
}

export const IDLE_NARRATION: NarrationState = { status: 'idle', index: 0, total: 0 }

/**
 * Reads a list of blocks aloud, chunk by chunk, and reports where it is.
 *
 * A plain class rather than a hook so its sequencing can be tested without a
 * browser. Every utterance carries the generation it was spoken in; anything
 * that interrupts speech starts a new generation, so the `end` or `error` an
 * interrupted utterance fires late is recognised and ignored.
 */
export class Narrator {
  private blocks: string[][] = []
  private index = 0
  private chunk = 0
  private status: NarrationStatus = 'idle'
  private generation = 0
  private rate = 1
  private voice: SpeechSynthesisVoice | null = null
  /**
   * The utterance being spoken. Held so it is not garbage-collected mid-way:
   * Chrome drops the `end` event of an utterance nothing references.
   */
  private current: SpeechSynthesisUtterance | null = null
  private readonly options: NarratorOptions

  constructor(options: NarratorOptions) {
    this.options = options
  }

  /** Replaces what is to be read, and stops reading whatever was. */
  load(texts: readonly string[]): void {
    this.interrupt()
    this.blocks = texts.map((text) => speechChunks(text))
    this.index = 0
    this.chunk = 0
    this.status = 'idle'
    this.emit()
  }

  /** Starts reading at a block (default: from the start of the current one). */
  play(from = this.index): void {
    if (this.blocks.length === 0) return
    this.interrupt()
    this.index = clamp(from, 0, this.blocks.length - 1)
    this.chunk = 0
    this.status = 'playing'
    this.emit()
    this.speakCurrent()
  }

  pause(): void {
    if (this.status !== 'playing') return
    this.interrupt()
    this.status = 'paused'
    this.emit()
  }

  /** Carries on from the start of the chunk that was interrupted. */
  resume(): void {
    if (this.status !== 'paused') return
    this.status = 'playing'
    this.emit()
    this.speakCurrent()
  }

  stop(): void {
    this.interrupt()
    if (this.status === 'idle' && this.index === 0) return
    this.status = 'idle'
    this.index = 0
    this.chunk = 0
    this.emit()
  }

  /**
   * Moves a block forwards or back. Playing carries on playing from there;
   * paused stays paused there.
   */
  skip(delta: number): void {
    if (this.blocks.length === 0) return
    const target = clamp(this.index + delta, 0, this.blocks.length - 1)
    if (this.status === 'playing') {
      this.play(target)
      return
    }
    this.interrupt()
    this.index = target
    this.chunk = 0
    if (this.status !== 'paused') this.status = 'paused'
    this.emit()
  }

  /** Takes effect at once: the current chunk is spoken again at the new rate. */
  setRate(rate: number): void {
    if (rate === this.rate) return
    this.rate = rate
    this.restartChunk()
  }

  setVoice(voice: SpeechSynthesisVoice | null): void {
    if (voice === this.voice) return
    this.voice = voice
    this.restartChunk()
  }

  getState(): NarrationState {
    return { status: this.status, index: this.index, total: this.blocks.length }
  }

  private restartChunk(): void {
    if (this.status !== 'playing') return
    this.interrupt()
    this.speakCurrent()
  }

  private speakCurrent(): void {
    const text = this.blocks[this.index]?.[this.chunk]
    if (text === undefined) {
      this.advance()
      return
    }

    const generation = ++this.generation
    const utterance = this.options.makeUtterance(text)
    utterance.rate = this.rate
    if (this.voice) {
      utterance.voice = this.voice
      utterance.lang = this.voice.lang
    } else if (this.options.lang) {
      utterance.lang = this.options.lang
    }

    utterance.onend = () => {
      if (generation !== this.generation) return
      this.current = null
      this.advance()
    }
    utterance.onerror = (event) => {
      if (generation !== this.generation) return
      // What `cancel()` reports. Only reached if something else cancelled
      // speech -- another tab, the operating system -- so stop cleanly.
      const error = (event as SpeechSynthesisErrorEvent).error
      this.current = null
      this.status = error === 'interrupted' || error === 'canceled' ? 'paused' : 'error'
      this.emit()
    }

    this.current = utterance
    this.options.engine.speak(utterance)
  }

  /** On to the next chunk, the next block, or the end. */
  private advance(): void {
    if (this.status !== 'playing') return

    if (this.chunk + 1 < (this.blocks[this.index]?.length ?? 0)) {
      this.chunk += 1
      this.speakCurrent()
      return
    }

    if (this.index + 1 < this.blocks.length) {
      this.index += 1
      this.chunk = 0
      this.emit()
      this.speakCurrent()
      return
    }

    this.status = 'finished'
    this.emit()
  }

  /** Silences whatever is being spoken, without reporting a change. */
  private interrupt(): void {
    this.generation += 1
    if (this.current !== null) {
      this.current = null
      this.options.engine.cancel()
    }
  }

  private emit(): void {
    this.options.onChange(this.getState())
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
