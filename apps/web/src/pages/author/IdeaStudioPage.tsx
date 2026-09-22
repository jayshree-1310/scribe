import { useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAsync } from '../../hooks/useAsync'
import { useToast } from '../../lib/toast'
import { ApiError } from '../../lib/api-client'
import * as aiApi from '../../data/ai-api'
import * as authoringApi from '../../data/authoring-api'
import * as storiesApi from '../../data/stories-api'
import { Button } from '../../components/ui/Button'
import { Card, SectionHead } from '../../components/ui/Card'
import { Icon } from '../../components/ui/Icon'
import { Select } from '../../components/ui/Select'
import { SegmentedControl } from '../../components/ui/Tabs'
import { TextField } from '../../components/ui/TextField'
import { EmptyState } from '../../components/ui/States'
import '../pages.css'
import './author.css'
import './idea-studio.css'

/**
 * The brainstorming surface: premises, characters and chapter outlines.
 *
 * Everything on this page was written by a model and none of it is saved.
 * That is the design, not an omission — the author decides what becomes a
 * story, and until they press "Start a story" nothing has been created. The
 * generated text is labelled everywhere it appears for the same reason.
 *
 * Refinement sends a session id and a position back to the server, never the
 * object on screen: the server still holds what the model wrote, and revising
 * from its copy is what keeps "refine" an edit of the model's own output.
 */

type Kind = aiApi.GenerationKind

const KINDS: ReadonlyArray<{ value: Kind; label: string }> = [
  { value: 'idea', label: 'Story idea' },
  { value: 'character', label: 'Character' },
  { value: 'outline', label: 'Chapter outline' },
]

const PLACEHOLDER: Record<Kind, string> = {
  idea: 'A lighthouse keeper starts receiving letters she has not sent…',
  character: 'The rival mapmaker who trained alongside my protagonist…',
  outline: 'The chapter where she finally answers one of the letters…',
}

const COUNTS = [
  { value: '1', label: '1' },
  { value: '2', label: '2' },
  { value: '3', label: '3' },
] as const

function isIdea(value: aiApi.GeneratedValue): value is aiApi.StoryIdea {
  return 'premise' in value
}

function isCharacter(
  value: aiApi.GeneratedValue,
): value is aiApi.CharacterProfile {
  return 'motivations' in value
}

/** The heading each card shows, whichever shape it holds. */
function titleOf(value: aiApi.GeneratedValue): string {
  return 'title' in value ? value.title : value.name
}

/* Rendering one generated object ----------------------------------------- */

function Detail({ label, children }: { label: string; children: string }) {
  return (
    <div className="generated__detail">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function List({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null

  return (
    <div className="generated__detail">
      <dt>{label}</dt>
      <dd>
        <ul className="generated__list">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </dd>
    </div>
  )
}

function GeneratedBody({ value }: { value: aiApi.GeneratedValue }) {
  if (isIdea(value)) {
    return (
      <dl className="generated__body">
        <Detail label="Premise">{value.premise}</Detail>
        <Detail label="Genre">{value.genre}</Detail>
        <List
          label="Characters"
          items={value.characters.map(
            (character) => `${character.name} — ${character.role}`,
          )}
        />
        <Detail label="Conflict">{value.conflict}</Detail>
        <Detail label="Setting">{value.setting}</Detail>
        <Detail label="Where it ends">{value.ending}</Detail>
      </dl>
    )
  }

  if (isCharacter(value)) {
    return (
      <dl className="generated__body">
        <Detail label="Role">{value.role}</Detail>
        <Detail label="Personality">{value.personality}</Detail>
        <List label="Motivations" items={value.motivations} />
        <List label="Strengths" items={value.strengths} />
        <List label="Weaknesses" items={value.weaknesses} />
        <List
          label="Relationships"
          items={value.relationships.map(
            (relation) => `${relation.name} — ${relation.relationship}`,
          )}
        />
      </dl>
    )
  }

  return (
    <dl className="generated__body">
      <Detail label="Summary">{value.summary}</Detail>
      <List
        label="Scenes"
        items={value.scenes.map((scene) => `${scene.title} — ${scene.summary}`)}
      />
      <List label="Characters" items={value.characters} />
      <Detail label="Conflict">{value.conflict}</Detail>
      <Detail label="Ending hook">{value.endingHook}</Detail>
    </dl>
  )
}

/* The page --------------------------------------------------------------- */

export function IdeaStudioPage() {
  const navigate = useNavigate()
  const { showToast } = useToast()

  const [kind, setKind] = useState<Kind>('idea')
  const [genre, setGenre] = useState('')
  const [theme, setTheme] = useState('')
  const [premise, setPremise] = useState('')
  const [storyId, setStoryId] = useState('')
  const [count, setCount] = useState<'1' | '2' | '3'>('1')

  const [result, setResult] = useState<aiApi.GenerationResult | null>(null)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [instructions, setInstructions] = useState<Record<number, string>>({})
  const [refining, setRefining] = useState<number | null>(null)
  const [starting, setStarting] = useState<number | null>(null)

  /** Abandons an in-flight generation when a second one is asked for. */
  const pending = useRef<AbortController | null>(null)

  /**
   * The author's own stories, so material can be generated to fit one. Drafts
   * included — an unpublished story is exactly what somebody is most likely to
   * be brainstorming for.
   */
  const stories = useAsync(
    () => authoringApi.listMyStories().then((page) => page.items),
    [],
  )

  async function onGenerate(event: FormEvent) {
    event.preventDefault()

    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller

    setGenerating(true)
    setError(null)

    try {
      const generated = await aiApi.generate(
        kind,
        {
          genre: genre.trim() || null,
          theme: theme.trim() || null,
          premise: premise.trim() || null,
          storyId: storyId || null,
        },
        Number(count),
        controller.signal,
      )
      if (controller.signal.aborted) return
      setResult(generated)
      setInstructions({})
    } catch (cause) {
      if (controller.signal.aborted) return
      setError(
        cause instanceof ApiError
          ? cause.message
          : 'Nothing could be generated just now.',
      )
    } finally {
      if (!controller.signal.aborted) setGenerating(false)
    }
  }

  async function onRefine(index: number) {
    const instruction = (instructions[index] ?? '').trim()
    if (!result || instruction.length === 0) return

    setRefining(index)
    try {
      const refined = await aiApi.refineGeneration(
        result.sessionId,
        index,
        instruction,
      )
      // Only the revised variant changes; the others are still the objects the
      // server holds, and their session ids are unchanged.
      setResult({
        ...result,
        variants: result.variants.map((variant, position) =>
          position === index ? refined.value : variant,
        ),
      })
      setInstructions((current) => ({ ...current, [index]: '' }))
    } catch (cause) {
      showToast({
        tone: 'error',
        message:
          cause instanceof ApiError
            ? cause.message
            : 'That could not be revised just now.',
      })
    } finally {
      setRefining(null)
    }
  }

  /**
   * Turns an accepted idea into a real draft.
   *
   * The generated genre is a free string, so it is matched against the real
   * genre list and simply left off when nothing matches — a story that starts
   * without a genre is fine, a story that fails to start is not.
   */
  async function onStartStory(value: aiApi.GeneratedValue, index: number) {
    if (!isIdea(value)) return

    setStarting(index)
    try {
      const genres = await storiesApi.getGenres()
      const matched = genres.find(
        (candidate) => candidate.name.toLowerCase() === value.genre.toLowerCase(),
      )

      const created = await authoringApi.createStory({
        title: value.title,
        description: value.premise,
        ...(matched ? { genreIds: [matched.id] } : {}),
      })

      showToast({ message: `“${created.title}” started as a draft.` })
      navigate(`/author/stories/${created.slug}`)
    } catch (cause) {
      showToast({
        tone: 'error',
        message:
          cause instanceof ApiError
            ? cause.message
            : 'That story could not be started.',
      })
    } finally {
      setStarting(null)
    }
  }

  const storyOptions = [
    { value: '', label: 'Not about an existing story' },
    ...(stories.data ?? []).map((story) => ({
      value: story.id,
      label: story.title,
    })),
  ]

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-head__title">Idea studio</h1>
          <p className="page-head__sub">
            Premises, characters and chapter outlines to argue with. Nothing
            here is saved until you start a story from it.
          </p>
        </div>
      </header>

      <Card className="idea-form">
        <form onSubmit={onGenerate}>
          <SegmentedControl
            label="What to generate"
            items={KINDS}
            value={kind}
            onChange={(next) => setKind(next)}
          />

          <div className="idea-form__grid">
            <TextField
              label="Genre"
              value={genre}
              maxLength={60}
              placeholder="Fantasy, mystery, literary…"
              onChange={(event) => setGenre(event.target.value)}
            />
            <TextField
              label="Theme or mood"
              value={theme}
              maxLength={80}
              placeholder="Quiet dread, second chances…"
              onChange={(event) => setTheme(event.target.value)}
            />
            <Select
              label="For one of your stories"
              value={storyId}
              options={storyOptions}
              onChange={setStoryId}
            />
            <Select
              label="Alternatives"
              value={count}
              options={COUNTS}
              onChange={(next) => setCount(next)}
            />
          </div>

          <TextField
            label="Anything else"
            multiline
            rows={3}
            value={premise}
            maxLength={400}
            counterMax={400}
            placeholder={PLACEHOLDER[kind]}
            hint="Every field is optional. “Surprise me” is a valid brief."
            onChange={(event) => setPremise(event.target.value)}
          />

          <div className="idea-form__actions">
            <Button
              type="submit"
              variant="primary"
              loading={generating}
              startIcon={<Icon name="sparkle" size="1em" />}
            >
              {generating ? 'Writing…' : 'Generate'}
            </Button>
            <p className="idea-form__note">
              Each alternative is a separate request, and a local model can take
              most of a minute over one.
            </p>
          </div>

          {error ? (
            <p className="idea-form__error" role="alert">
              <Icon name="alert" size="0.95em" />
              {error}
            </p>
          ) : null}
        </form>
      </Card>

      {result === null ? (
        generating ? null : (
          <EmptyState
            icon="sparkle"
            title="Nothing generated yet"
            description="Describe what you are after — or describe nothing at all — and see what comes back."
          />
        )
      ) : (
        <section className="generated" aria-label="Generated material">
          <SectionHead
            title={result.variants.length === 1 ? 'One option' : 'Options'}
            action={
              <span className="generated__notice">
                <Icon name="sparkle" size="0.9em" />
                AI-generated. Check it before you use it.
              </span>
            }
          />

          <div className="generated__grid">
            {result.variants.map((value, index) => (
              <Card key={`${result.sessionId}-${index}`} className="generated__card">
                <h3 className="generated__title">{titleOf(value)}</h3>
                <GeneratedBody value={value} />

                <div className="generated__actions">
                  <TextField
                    label="What should change?"
                    hideLabel
                    value={instructions[index] ?? ''}
                    maxLength={400}
                    placeholder="Make her older. Lose the prophecy."
                    onChange={(event) =>
                      setInstructions((current) => ({
                        ...current,
                        [index]: event.target.value,
                      }))
                    }
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void onRefine(index)
                      }
                    }}
                  />
                  <div className="generated__buttons">
                    <Button
                      size="sm"
                      loading={refining === index}
                      disabled={(instructions[index] ?? '').trim().length === 0}
                      onClick={() => void onRefine(index)}
                    >
                      Refine
                    </Button>
                    {isIdea(value) ? (
                      <Button
                        size="sm"
                        variant="primary"
                        loading={starting === index}
                        startIcon={<Icon name="pen" size="0.9em" />}
                        onClick={() => void onStartStory(value, index)}
                      >
                        Start a story
                      </Button>
                    ) : null}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}
    </>
  )
}
