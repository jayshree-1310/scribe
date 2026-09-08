import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAsync } from '../hooks/useAsync'
import { useAuth } from '../lib/auth'
import { cn } from '../lib/cn'
import { formatCount } from '../lib/format'
import * as api from '../data/api'
import { Avatar } from '../components/ui/Avatar'
import { Button } from '../components/ui/Button'
import { SelectableChip } from '../components/ui/Chip'
import { Icon } from '../components/ui/Icon'
import { Logo } from '../components/layout/Logo'
import { InlineNotice, ErrorState } from '../components/ui/States'
import { Skeleton } from '../components/ui/Skeleton'
import './auth.css'
import './onboarding.css'

const INTERESTS = [
  'Serials that update weekly',
  'Finished stories I can binge',
  'Short reads under an hour',
  'Novel-length epics',
  'Audio narration',
  'Illustrated chapters',
  'Slow, literary prose',
  'Plot-driven page-turners',
]

const WRITING_ANSWERS = [
  { id: 'yes', label: 'Yes — I already write', detail: 'Take me to the author studio too' },
  { id: 'maybe', label: 'Maybe one day', detail: 'Show me challenges and prompts' },
  { id: 'no', label: 'Just here to read', detail: 'Keep my feed all about reading' },
] as const

const STEPS = ['Genres', 'Authors', 'Reading', 'Writing'] as const

export function OnboardingPage() {
  const { completeOnboarding } = useAuth()
  const navigate = useNavigate()

  const genres = useAsync(() => api.getGenres(), [])
  const authors = useAsync(() => api.getAuthors(), [])

  const [step, setStep] = useState(0)
  const [genreIds, setGenreIds] = useState<string[]>([])
  const [authorIds, setAuthorIds] = useState<string[]>([])
  const [interests, setInterests] = useState<string[]>([])
  const [writing, setWriting] = useState<(typeof WRITING_ANSWERS)[number]['id'] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((item) => item !== id) : [...list, id]

  const canAdvance = useMemo(() => {
    if (step === 0) return genreIds.length >= 3
    if (step === 3) return writing !== null
    return true
  }, [step, genreIds.length, writing])

  function next() {
    if (!canAdvance) {
      setError(
        step === 0
          ? 'Pick at least three genres so we have something to work with.'
          : 'Choose one option to continue.',
      )
      return
    }
    setError(null)
    setStep((current) => Math.min(current + 1, STEPS.length - 1))
  }

  function finish() {
    if (writing === null) {
      setError('Choose one option to continue.')
      return
    }

    setSubmitting(true)
    completeOnboarding({
      favoriteGenreIds: genreIds,
      followedAuthorIds: authorIds,
      interests,
      wantsToWrite: writing === 'yes',
    })
    navigate('/home', { replace: true })
  }

  return (
    <div className="onboarding">
      <header className="onboarding__header">
        <Logo to="/" />
        <button className="onboarding__skip" type="button" onClick={finish}>
          Skip for now
        </button>
      </header>

      <div className="onboarding__body">
        <ol className="steps" aria-label="Onboarding progress">
          {STEPS.map((label, index) => (
            <li
              key={label}
              className={cn(
                'steps__item',
                index === step && 'is-current',
                index < step && 'is-done',
              )}
              aria-current={index === step ? 'step' : undefined}
            >
              <span className="steps__dot">
                {index < step ? <Icon name="check" size="0.7rem" strokeWidth={3} /> : index + 1}
              </span>
              <span className="steps__label">{label}</span>
            </li>
          ))}
        </ol>

        {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

        {step === 0 ? (
          <section className="onboarding__step">
            <h1>What do you love to read?</h1>
            <p className="onboarding__lede">
              Pick at least three. This shapes your feed from the first visit —
              you can change it any time in Settings.
            </p>

            {genres.status === 'error' ? (
              <ErrorState message={genres.error} onRetry={genres.reload} />
            ) : genres.status === 'loading' ? (
              <div className="chip-row">
                {Array.from({ length: 10 }, (_, index) => (
                  <Skeleton key={index} width="7rem" height="2.75rem" radius="var(--radius-full)" />
                ))}
              </div>
            ) : (
              <div className="chip-row">
                {genres.data?.map((genre) => (
                  <SelectableChip
                    key={genre.id}
                    hue={genre.hue}
                    selected={genreIds.includes(genre.id)}
                    onToggle={() => {
                      setGenreIds((current) => toggle(current, genre.id))
                      setError(null)
                    }}
                  >
                    {genre.name}
                  </SelectableChip>
                ))}
              </div>
            )}

            <p className="onboarding__count" aria-live="polite">
              {genreIds.length} selected
              {genreIds.length < 3 ? ` · ${3 - genreIds.length} more to go` : ''}
            </p>
          </section>
        ) : null}

        {step === 1 ? (
          <section className="onboarding__step">
            <h1>Follow a few authors</h1>
            <p className="onboarding__lede">
              You'll see their new chapters first. Optional — skip if you'd
              rather discover as you go.
            </p>

            <div className="onboarding__authors">
              {authors.data?.map((author) => {
                const selected = authorIds.includes(author.id)
                return (
                  <button
                    key={author.id}
                    type="button"
                    className={cn('follow-card', selected && 'is-selected')}
                    aria-pressed={selected}
                    onClick={() => setAuthorIds((current) => toggle(current, author.id))}
                  >
                    <Avatar user={author} size="md" />
                    <span className="follow-card__text">
                      <strong>{author.displayName}</strong>
                      <span>{formatCount(author.followerCount)} followers</span>
                    </span>
                    <span className="follow-card__state" aria-hidden="true">
                      <Icon name={selected ? 'check' : 'plus'} size="0.95rem" strokeWidth={2.4} />
                    </span>
                  </button>
                )
              })}
            </div>
          </section>
        ) : null}

        {step === 2 ? (
          <section className="onboarding__step">
            <h1>How do you like to read?</h1>
            <p className="onboarding__lede">
              We'll prioritise the kinds of stories that fit how you actually read.
            </p>

            <div className="chip-row">
              {INTERESTS.map((interest) => (
                <SelectableChip
                  key={interest}
                  selected={interests.includes(interest)}
                  onToggle={() => setInterests((current) => toggle(current, interest))}
                >
                  {interest}
                </SelectableChip>
              ))}
            </div>
          </section>
        ) : null}

        {step === 3 ? (
          <section className="onboarding__step">
            <h1>Do you write too?</h1>
            <p className="onboarding__lede">
              Scribe is both halves. If you write, we'll set up your studio now.
            </p>

            <div className="onboarding__choices" role="radiogroup" aria-label="Writing interest">
              {WRITING_ANSWERS.map((answer) => (
                <button
                  key={answer.id}
                  type="button"
                  role="radio"
                  aria-checked={writing === answer.id}
                  className={cn('choice-card', writing === answer.id && 'is-selected')}
                  onClick={() => {
                    setWriting(answer.id)
                    setError(null)
                  }}
                >
                  <span className="choice-card__radio" aria-hidden="true" />
                  <span>
                    <strong>{answer.label}</strong>
                    <span>{answer.detail}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <div className="onboarding__actions">
          <Button
            variant="ghost"
            disabled={step === 0 || submitting}
            onClick={() => setStep((current) => Math.max(0, current - 1))}
            startIcon={<Icon name="chevron-left" size="0.95em" />}
          >
            Back
          </Button>

          {step < STEPS.length - 1 ? (
            <Button
              variant="primary"
              size="lg"
              onClick={next}
              endIcon={<Icon name="arrow-right" size="0.95em" />}
            >
              Continue
            </Button>
          ) : (
            <Button
              variant="primary"
              size="lg"
              loading={submitting}
              onClick={finish}
              startIcon={<Icon name="sparkle" size="1em" />}
            >
              Build My Reading Feed
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
