import { useEffect, useMemo, useState } from 'react'
import {
  IDLE_NARRATION,
  Narrator,
  type NarrationState,
} from '../lib/narration'

/** Whether this browser can speak at all. Checked once; it does not change. */
export const SPEECH_SUPPORTED =
  typeof window !== 'undefined' &&
  'speechSynthesis' in window &&
  typeof window.SpeechSynthesisUtterance === 'function'

/** The page's language, which is what a story is assumed to be written in. */
function pageLanguage(): string {
  return (typeof document === 'undefined' ? '' : document.documentElement.lang) || 'en'
}

/**
 * The voices worth offering: those for the page's language. Some systems
 * list a hundred voices in forty languages, and a French voice reading an
 * English chapter is not a choice anybody wants to scroll past. When the
 * browser lists none for the language, all of them are offered instead.
 */
function voicesFor(all: SpeechSynthesisVoice[], lang: string): SpeechSynthesisVoice[] {
  const prefix = lang.toLowerCase().split('-')[0]
  const matching = all.filter((voice) => voice.lang.toLowerCase().startsWith(prefix))
  return (matching.length > 0 ? matching : all)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
}

export interface Narration {
  state: NarrationState
  voices: SpeechSynthesisVoice[]
  narrator: Narrator | null
}

/**
 * A narrator for the reader, its state, and the voices it may use.
 *
 * `rate` and `voiceURI` are the reader's stored preferences, applied as they
 * change -- including mid-sentence, which restarts the sentence. A voice that
 * is no longer installed falls back to the browser's default for the page's
 * language. Speech stops when the page unmounts.
 */
export function useNarration(rate: number, voiceURI: string | null): Narration {
  const [state, setState] = useState<NarrationState>(IDLE_NARRATION)

  const narrator = useMemo(() => {
    if (!SPEECH_SUPPORTED) return null
    return new Narrator({
      engine: window.speechSynthesis,
      makeUtterance: (text) => new SpeechSynthesisUtterance(text),
      lang: pageLanguage(),
      onChange: setState,
    })
  }, [])

  /**
   * The browser loads its voice list asynchronously: Chrome returns an empty
   * list until `voiceschanged` fires, Safari and Firefox usually have it at
   * once. Both paths go through the listener's callback.
   */
  const [allVoices, setAllVoices] = useState<SpeechSynthesisVoice[]>(() =>
    SPEECH_SUPPORTED ? window.speechSynthesis.getVoices() : [],
  )
  useEffect(() => {
    if (!SPEECH_SUPPORTED) return
    const synth = window.speechSynthesis
    const refresh = () => setAllVoices(synth.getVoices())
    synth.addEventListener('voiceschanged', refresh)
    return () => synth.removeEventListener('voiceschanged', refresh)
  }, [])

  const voices = useMemo(() => voicesFor(allVoices, pageLanguage()), [allVoices])
  const voice = voices.find((candidate) => candidate.voiceURI === voiceURI) ?? null

  useEffect(() => {
    narrator?.setRate(rate)
  }, [narrator, rate])

  useEffect(() => {
    narrator?.setVoice(voice)
  }, [narrator, voice])

  /**
   * Silence on the way out. Also clears anything another page left queued:
   * a queue stuck from elsewhere would hold every utterance this one speaks.
   */
  useEffect(() => {
    if (!narrator) return
    window.speechSynthesis.cancel()
    return () => {
      narrator.stop()
      window.speechSynthesis.cancel()
    }
  }, [narrator])

  return { state, voices, narrator }
}
