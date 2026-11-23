import { describe, expect, it } from 'vitest'
import {
  MAX_CHUNK_LENGTH,
  Narrator,
  narrationBlocks,
  speechChunks,
  type NarrationState,
} from './narration'

/** An utterance as the narrator uses one: text, settings, and two handlers. */
class FakeUtterance {
  text: string
  rate = 1
  lang = ''
  voice: SpeechSynthesisVoice | null = null
  onend: (() => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null
  constructor(text: string) {
    this.text = text
  }
}

/**
 * A speech engine that speaks nothing and remembers everything. `finish()`
 * ends the utterance being spoken, as the browser would; `cancel()` fires the
 * error a real cancel does, so the narrator's guard against it is exercised.
 */
function fakeEngine() {
  const spoken: FakeUtterance[] = []
  let speaking: FakeUtterance | null = null
  let cancels = 0
  return {
    spoken,
    get cancels() {
      return cancels
    },
    speak(utterance: SpeechSynthesisUtterance) {
      const fake = utterance as unknown as FakeUtterance
      spoken.push(fake)
      speaking = fake
    },
    cancel() {
      cancels += 1
      const was = speaking
      speaking = null
      was?.onerror?.({ error: 'interrupted' })
    },
    finish() {
      const was = speaking
      speaking = null
      was?.onend?.()
    },
  }
}

function setup(texts: string[]) {
  const engine = fakeEngine()
  const states: NarrationState[] = []
  const narrator = new Narrator({
    engine,
    makeUtterance: (text) => new FakeUtterance(text) as unknown as SpeechSynthesisUtterance,
    lang: 'en',
    onChange: (state) => states.push(state),
  })
  narrator.load(texts)
  return { engine, narrator, states, last: () => states[states.length - 1] }
}

describe('speechChunks', () => {
  it('keeps short sentences together, up to the limit', () => {
    expect(speechChunks('One. Two!  Three?')).toEqual(['One. Two! Three?'])
  })

  it('starts a new chunk at a sentence boundary when one would overflow', () => {
    const sentence = `${'word '.repeat(20).trim()}.`
    const chunks = speechChunks(`${sentence} ${sentence} ${sentence}`, 120)
    expect(chunks).toEqual([sentence, sentence, sentence])
  })

  it('breaks an over-long sentence at a comma, else at a space', () => {
    const long = `${'a '.repeat(60)}then, ${'b '.repeat(80)}end.`
    const chunks = speechChunks(long)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK_LENGTH)
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(long.replace(/\s+/g, ' ').trim())
  })

  it('keeps closing quotes with their sentence', () => {
    expect(speechChunks('“Go.” She went.', 6)).toEqual(['“Go.”', 'She', 'went.'])
  })

  it('has nothing to say about whitespace', () => {
    expect(speechChunks('  \n ')).toEqual([])
  })
})

describe('narrationBlocks', () => {
  it('reads the title and prose blocks in order, and not media captions', () => {
    document.body.innerHTML = `
      <article>
        <p class="reader__eyebrow">Chapter 1</p>
        <h1 class="reader__title">The Title</h1>
        <div class="reader__prose">
          <p>First.</p>
          <figure><p>A caption</p></figure>
          <h2>Part two</h2>
          <ul><li>Item</li></ul>
          <p>   </p>
          <blockquote>Said.</blockquote>
        </div>
      </article>`
    const texts = narrationBlocks(document.body).map((block) => block.textContent)
    expect(texts).toEqual(['The Title', 'First.', 'Part two', 'Item', 'Said.'])
  })
})

describe('Narrator', () => {
  it('reads every chunk of every block, then finishes', () => {
    const long = `${'word '.repeat(30).trim()}. ${'more '.repeat(30).trim()}.`
    const { engine, narrator, last } = setup(['Title', long])
    narrator.play(0)
    expect(last()).toEqual({ status: 'playing', index: 0, total: 2 })

    engine.finish()
    expect(last().index).toBe(1)
    expect(engine.spoken.map((u) => u.text)).toEqual(['Title', speechChunks(long)[0]])

    engine.finish()
    expect(engine.spoken).toHaveLength(3)
    engine.finish()
    expect(last()).toEqual({ status: 'finished', index: 1, total: 2 })
  })

  it('pauses by cancelling, and resumes the interrupted chunk', () => {
    const { engine, narrator, last } = setup(['One.', 'Two.'])
    narrator.play(1)
    narrator.pause()
    expect(last().status).toBe('paused')
    // The late error from the cancel is not mistaken for anything.
    expect(engine.cancels).toBe(1)

    narrator.resume()
    expect(last()).toEqual({ status: 'playing', index: 1, total: 2 })
    expect(engine.spoken.map((u) => u.text)).toEqual(['Two.', 'Two.'])
  })

  it('ignores the end of an utterance it has moved on from', () => {
    const { engine, narrator, last } = setup(['One.', 'Two.', 'Three.'])
    narrator.play(0)
    const first = engine.spoken[0]
    narrator.skip(1)
    // A browser that reports the old utterance ending after all.
    first.onend?.()
    expect(last()).toEqual({ status: 'playing', index: 1, total: 3 })
    expect(engine.spoken.map((u) => u.text)).toEqual(['One.', 'Two.'])
  })

  it('skips while paused without speaking', () => {
    const { engine, narrator, last } = setup(['One.', 'Two.', 'Three.'])
    narrator.play(0)
    narrator.pause()
    narrator.skip(5)
    expect(last()).toEqual({ status: 'paused', index: 2, total: 3 })
    expect(engine.spoken).toHaveLength(1)
  })

  it('applies a new rate to the chunk being read at once', () => {
    const { engine, narrator } = setup(['One.'])
    narrator.play(0)
    narrator.setRate(1.5)
    expect(engine.spoken.map((u) => [u.text, u.rate])).toEqual([
      ['One.', 1],
      ['One.', 1.5],
    ])
  })

  it('stops on a speech error the reader did not cause', () => {
    const { engine, narrator, last } = setup(['One.'])
    narrator.play(0)
    engine.spoken[0].onerror?.({ error: 'synthesis-failed' })
    expect(last().status).toBe('error')
  })

  it('stops and rewinds', () => {
    const { narrator, last } = setup(['One.', 'Two.'])
    narrator.play(1)
    narrator.stop()
    expect(last()).toEqual({ status: 'idle', index: 0, total: 2 })
  })
})
