import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAsync } from '../hooks/useAsync'
import { useAuth } from '../lib/auth'
import { cn } from '../lib/cn'
import { formatCount } from '../lib/format'
import * as storiesApi from '../data/stories-api'
import * as preferencesApi from '../data/preferences-api'
import * as recommendationsApi from '../data/recommendations-api'
import * as usersApi from '../data/users-api'
import { updateMyAccount } from '../data/account-api'
import { CONTENT_LENGTH_OPTIONS, type ContentLength } from '../types/preferences'
import { Avatar } from '../components/ui/Avatar'
import { Button } from '../components/ui/Button'
import { SelectableChip } from '../components/ui/Chip'
import { Icon } from '../components/ui/Icon'
import { Logo } from '../components/layout/Logo'
import { InlineNotice, EmptyState, ErrorState } from '../components/ui/States'
import { Skeleton } from '../components/ui/Skeleton'
import './auth.css'
import './onboarding.css'

const WRITING_ANSWERS = [
  { id: 'yes', label: 'Yes — I already write', detail: 'Take me to the author studio too' },
  { id: 'maybe', label: 'Maybe one day', detail: 'Show me challenges and prompts' },
  { id: 'no', label: 'Just here to read', detail: 'Keep my feed all about reading' },
] as const

const STEPS = ['Genres', 'Authors', 'Reading', 'Writing'] as const

const MIN_GENRES = 3

/**
 * The reader's first five minutes, and the only place their preferences are
 * created.
 *
 * **Every step saves as it is left.** The genres go to the API when the reader
 * leaves the first step, the follows the moment a card is pressed, the length
 * when the third step is left, and `onboardingComplete` at the end. That is
 * what makes a refresh halfway through resume rather than restart: the flow is
 * gated on the server's flag (`RequireAuth`), so a reader who closes the tab
 * comes back to it with their answers already in the chips.
 *
 * It is also why the author step can exist at all. The suggestions are ranked
 * by the genres the reader just saved, so the step before it has to have
 * written them down before this one asks -- which is the whole reason the
 * fixture list this page used to read is gone.
 *
 * **Skipping is an answer.** "Skip for now" marks onboarding complete with
 * whatever has been saved so far, rather than leaving the reader to be sent
 * back here on their next visit. The cold-start path in the recommender is
 * what makes that survivable: a reader who told us nothing gets trending.
 */
export function OnboardingPage() {
  const { completeOnboarding } = useAuth()
  const navigate = useNavigate()

  // Genres are real rows in `content.Genre`, served with story counts.
  const genres = useAsync(() => storiesApi.getGenres(), [])
  const saved = useAsync(() => preferencesApi.getPreferences(), [])

  /**
   * Bumped when the genre step is saved, which re-ranks the suggestions
   * against what the reader just chose. Without it the author step would show
   * the platform's most-followed writers however carefully the previous step
   * was answered.
   */
  const [authorsKey, setAuthorsKey] = useState(0)
  const authors = useAsync(
    () => recommendationsApi.getSuggestedAuthors(12),
    [authorsKey],
  )

  const [step, setStep] = useState(0)
  const [genreIds, setGenreIds] = useState<string[]>([])
  const [following, setFollowing] = useState<string[]>([])
  const [length, setLength] = useState<ContentLength>('ANY')
  const [writing, setWriting] = useState<(typeof WRITING_ANSWERS)[number]['id'] | null>(
    null,
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /**
   * Adopts what was saved on a previous visit, once. Not `useAsync`'s data
   * read straight into the inputs: these are edited, so they have to be state,
   * and seeding them on every render would fight the reader's own clicks.
   */
  const [adopted, setAdopted] = useState(false)
  useEffect(() => {
    if (adopted || saved.status !== 'ready' || !saved.data) return
    setGenreIds(saved.data.genreIds)
    setLength(saved.data.contentLength)
    setAdopted(true)
  }, [adopted, saved.status, saved.data])

  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((item) => item !== id) : [...list, id]

  const canAdvance = useMemo(() => {
    if (step === 0) return genreIds.length >= MIN_GENRES
    if (step === 3) return writing !== null
    return true
  }, [step, genreIds.length, writing])

  /** Runs a save, showing its failure rather than advancing past it. */
  async function guard(work: () => Promise<void>): Promise<boolean> {
    setBusy(true)
    setError(null)
    try {
      await work()
      return true
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'We could not save that. Please try again.',
      )
      return false
    } finally {
      setBusy(false)
    }
  }

  async function next() {
    if (!canAdvance) {
      setError(
        step === 0
          ? `Pick at least ${MIN_GENRES} genres so we have something to work with.`
          : 'Choose one option to continue.',
      )
      return
    }

    if (step === 0) {
      const ok = await guard(async () => {
        await preferencesApi.savePreferences({ genreIds })
      })
      if (!ok) return
      // Re-rank the author step against what was just saved.
      setAuthorsKey((key) => key + 1)
    }

    if (step === 2) {
      const ok = await guard(async () => {
        await preferencesApi.savePreferences({ contentLength: length })
      })
      if (!ok) return
    }

    setError(null)
    setStep((current) => Math.min(current + 1, STEPS.length - 1))
  }

  /**
   * Follows are written as they are pressed, not collected and sent at the
   * end: they are rows in the follow graph rather than part of this form, and
   * `POST /api/users/:username/follow` is idempotent, so a double press is a
   * no-op rather than a duplicate.
   */
  async function toggleFollow(username: string): Promise<void> {
    const wasFollowing = following.includes(username)

    // Optimistic, and rolled back below: the card has to answer the press.
    setFollowing((current) => toggle(current, username))

    try {
      if (wasFollowing) await usersApi.unfollowUser(username)
      else await usersApi.followUser(username)
    } catch (cause) {
      setFollowing((current) => toggle(current, username))
      setError(
        cause instanceof Error
          ? cause.message
          : 'We could not save that. Please try again.',
      )
    }
  }

  /** The last step, and the only place the flow is marked finished. */
  async function finish(): Promise<void> {
    if (writing === null) {
      setError('Choose one option to continue.')
      return
    }

    const ok = await guard(async () => {
      await preferencesApi.savePreferences({
        contentLength: length,
        onboardingComplete: true,
      })
      // Only ever set, never cleared: somebody who publishes later is made an
      // author by the authoring endpoints anyway, and answering "just here to
      // read" should not take the studio away from somebody who has one.
      if (writing === 'yes') await updateMyAccount({ isAuthor: true })
    })
    if (!ok) return

    completeOnboarding()
    navigate('/home', { replace: true })
  }

  async function skip(): Promise<void> {
    const ok = await guard(async () => {
      await preferencesApi.savePreferences({ onboardingComplete: true })
    })
    if (!ok) return

    completeOnboarding()
    navigate('/home', { replace: true })
  }

  return (
    <div className="onboarding">
      <header className="onboarding__header">
        <Logo to="/" />
        <button
          className="onboarding__skip"
          type="button"
          disabled={busy}
          onClick={() => void skip()}
        >
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
              Pick at least {MIN_GENRES}. This shapes your feed from the first
              visit — you can change it any time in Settings.
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
              {genreIds.length < MIN_GENRES
                ? ` · ${MIN_GENRES - genreIds.length} more to go`
                : ''}
            </p>
          </section>
        ) : null}

        {step === 1 ? (
          <section className="onboarding__step">
            <h1>Follow a few authors</h1>
            <p className="onboarding__lede">
              Writers in the genres you picked. You'll see their new chapters
              first — optional, so skip if you'd rather discover as you go.
            </p>

            {authors.status === 'error' ? (
              <ErrorState message={authors.error} onRetry={authors.reload} />
            ) : authors.status === 'loading' ? (
              <div className="onboarding__authors">
                {Array.from({ length: 6 }, (_, index) => (
                  <Skeleton key={index} height="4.25rem" radius="var(--radius-lg)" />
                ))}
              </div>
            ) : authors.data?.length === 0 ? (
              <EmptyState
                icon="users"
                size="sm"
                title="Nobody to suggest yet"
                description="Scribe has no published writers in those genres so far. You can follow people from their profiles any time."
              />
            ) : (
              <div className="onboarding__authors">
                {authors.data?.map((author) => {
                  const selected = following.includes(author.username)
                  return (
                    <button
                      key={author.id}
                      type="button"
                      className={cn('follow-card', selected && 'is-selected')}
                      aria-pressed={selected}
                      onClick={() => void toggleFollow(author.username)}
                    >
                      <Avatar user={author} size="md" />
                      <span className="follow-card__text">
                        <strong>{author.displayName || author.username}</strong>
                        <span>
                          {formatCount(author.followerCount)} followers ·{' '}
                          {author.storyCount}{' '}
                          {author.storyCount === 1 ? 'story' : 'stories'}
                        </span>
                      </span>
                      <span className="follow-card__state" aria-hidden="true">
                        <Icon name={selected ? 'check' : 'plus'} size="0.95rem" strokeWidth={2.4} />
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </section>
        ) : null}

        {step === 2 ? (
          <section className="onboarding__step">
            <h1>How long do you like them?</h1>
            <p className="onboarding__lede">
              We'll prioritise stories that fit the time you actually have.
            </p>

            <div className="onboarding__choices" role="radiogroup" aria-label="Preferred length">
              {CONTENT_LENGTH_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={length === option.id}
                  className={cn('choice-card', length === option.id && 'is-selected')}
                  onClick={() => {
                    setLength(option.id)
                    setError(null)
                  }}
                >
                  <span className="choice-card__radio" aria-hidden="true" />
                  <span>
                    <strong>{option.label}</strong>
                    <span>{option.detail}</span>
                  </span>
                </button>
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
            disabled={step === 0 || busy}
            onClick={() => setStep((current) => Math.max(0, current - 1))}
            startIcon={<Icon name="chevron-left" size="0.95em" />}
          >
            Back
          </Button>

          {step < STEPS.length - 1 ? (
            <Button
              variant="primary"
              size="lg"
              loading={busy}
              onClick={() => void next()}
              endIcon={<Icon name="arrow-right" size="0.95em" />}
            >
              Continue
            </Button>
          ) : (
            <Button
              variant="primary"
              size="lg"
              loading={busy}
              onClick={() => void finish()}
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
