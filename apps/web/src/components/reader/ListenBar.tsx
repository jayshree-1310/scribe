import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Select } from '../ui/Select'
import { LISTEN_RATES, type NarrationState } from '../../lib/narration'
import '../ai/reader-ai.css'
import './listen.css'

/**
 * Listen mode's player, docked to the bottom of the reader like the other
 * sheets: play and pause, a block back or forward, speed, and voice.
 *
 * It only shows and reports; `ReaderPage` owns the narrator, which block is
 * marked on the page, and following the narration as it goes.
 */

interface ListenBarProps {
  state: NarrationState
  rate: number
  onRate: (rate: number) => void
  voices: SpeechSynthesisVoice[]
  /** The chosen voice's `voiceURI`, or null for the browser's default. */
  voice: string | null
  onVoice: (voiceURI: string | null) => void
  /** Play, pause or resume, whichever the state calls for. */
  onToggle: () => void
  onSkip: (delta: number) => void
  /** The block being read is off screen, because the reader scrolled away. */
  away: boolean
  onFollow: () => void
  hasNextChapter: boolean
  onClose: () => void
}

function statusText(state: NarrationState, hasNextChapter: boolean): string {
  const where = `${state.index + 1} of ${state.total}`
  switch (state.status) {
    case 'playing':
      return `Reading · ${where}`
    case 'paused':
      return `Paused · ${where}`
    case 'finished':
      return hasNextChapter ? 'On to the next chapter…' : 'That is the end of the story.'
    case 'error':
      return 'Your browser stopped reading. Press play to try again.'
    default:
      return 'Reads this chapter aloud from where you are.'
  }
}

export function ListenBar({
  state,
  rate,
  onRate,
  voices,
  voice,
  onVoice,
  onToggle,
  onSkip,
  away,
  onFollow,
  hasNextChapter,
  onClose,
}: ListenBarProps) {
  const playing = state.status === 'playing'
  const started = state.status === 'playing' || state.status === 'paused'

  return (
    <aside className="explain-sheet listen-bar" aria-label="Listen to this chapter">
      <div className="explain-sheet__inner listen-bar__inner">
        <div className="listen-bar__controls">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Previous paragraph"
            title="Previous paragraph"
            disabled={!started || state.index === 0}
            onClick={() => onSkip(-1)}
            startIcon={<Icon name="skip-back" size="1rem" />}
          />
          <Button
            variant="primary"
            iconOnly
            className="listen-bar__play"
            aria-label={playing ? 'Pause' : started ? 'Resume' : 'Play'}
            onClick={onToggle}
            startIcon={<Icon name={playing ? 'pause' : 'play'} size="1.1rem" />}
          />
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Next paragraph"
            title="Next paragraph"
            disabled={!started || state.index >= state.total - 1}
            onClick={() => onSkip(1)}
            startIcon={<Icon name="skip-forward" size="1rem" />}
          />
        </div>

        <p className="listen-bar__status" aria-live="polite">
          <span>{statusText(state, hasNextChapter)}</span>
          {away && started ? (
            <button type="button" className="listen-bar__follow" onClick={onFollow}>
              Back to the narration
            </button>
          ) : null}
        </p>

        <div className="listen-bar__options">
          <Select
            label="Speed"
            hideLabel
            size="sm"
            value={String(rate)}
            options={LISTEN_RATES.map((value) => ({
              value: String(value),
              label: `${value}×`,
            }))}
            onChange={(value) => onRate(Number(value))}
          />
          {/* One voice, or none listed yet, is not a choice. */}
          {voices.length > 1 ? (
            <Select
              label="Voice"
              hideLabel
              size="sm"
              value={voice ?? ''}
              options={[
                { value: '', label: 'Default voice' },
                ...voices.map((item) => ({ value: item.voiceURI, label: item.name })),
              ]}
              onChange={(value) => onVoice(value === '' ? null : value)}
            />
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Stop listening"
            title="Stop listening"
            onClick={onClose}
            startIcon={<Icon name="close" size="1rem" />}
          />
        </div>
      </div>
    </aside>
  )
}
