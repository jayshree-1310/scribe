import { useMemo, useRef, useState, type FormEvent } from 'react'
import { useParams } from 'react-router-dom'
import { useAsync } from '../../hooks/useAsync'
import { useToast } from '../../lib/toast'
import { ApiError } from '../../lib/api-client'
import * as aiApi from '../../data/ai-api'
import * as storiesApi from '../../data/stories-api'
import { Button, ButtonLink } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { StatusBadge } from '../../components/ui/Chip'
import { Icon } from '../../components/ui/Icon'
import { Select } from '../../components/ui/Select'
import { Skeleton } from '../../components/ui/Skeleton'
import { SegmentedControl } from '../../components/ui/Tabs'
import { TextField } from '../../components/ui/TextField'
import { EmptyState, ErrorState } from '../../components/ui/States'
import { groupBySubject } from '../../lib/bible-groups'
import '../pages.css'
import './author.css'
import './story-bible.css'

/**
 * The story bible: what the author's own chapters establish.
 *
 * Three things this page has to get right, because each is a way an extracted
 * list of "facts" turns into something an author stops trusting:
 *
 * - **Every extracted fact shows its evidence.** The chapter's own words sit
 *   under the claim, with the chapter they are from, so a wrong reading is
 *   visibly wrong rather than quietly wrong.
 * - **Extraction is a draft.** Any fact can be corrected or removed, and the
 *   page says which facts are the author's and which are a model's reading. A
 *   corrected fact is kept when its chapter is read again; a removed one stays
 *   removed.
 * - **Nothing is read behind the author's back.** Chapters are read when they
 *   press the button, one at a time, with the count on screen and a way to
 *   stop.
 */

type KindFilter = 'all' | aiApi.FactKind

const KIND_FILTERS: ReadonlyArray<{ value: KindFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'character', label: 'Characters' },
  { value: 'location', label: 'Places' },
  { value: 'relationship', label: 'Relationships' },
  { value: 'event', label: 'Events' },
]

const KIND_OPTIONS: ReadonlyArray<{ value: aiApi.FactKind; label: string }> = [
  { value: 'character', label: 'Character' },
  { value: 'location', label: 'Place' },
  { value: 'relationship', label: 'Relationship' },
  { value: 'event', label: 'Event' },
]

const STATE_LABELS: Record<aiApi.ChapterBibleState, string> = {
  missing: 'Not read',
  stale: 'Changed since',
  current: 'Read',
}

function messageFor(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.message : fallback
}

/** Where a fact comes from, in a line. */
function sourceOf(fact: aiApi.StoryFact): string {
  if (fact.chapterNumber === null) return 'Whole story'
  return `Chapter ${fact.chapterNumber}${fact.chapterTitle ? `: ${fact.chapterTitle}` : ''}`
}

export function StoryBiblePage() {
  const { slug } = useParams()
  const { showToast } = useToast()

  const loaded = useAsync(async () => {
    if (!slug) return null

    const story = await storiesApi.getStory(slug)
    const bible = await aiApi.getStoryBible(story.id)
    return { story, bible }
  }, [slug])

  /**
   * The bible as last told by the server. Seeded from the load during render
   * — the pattern the editor uses for state derived from a request — and then
   * replaced by each refresh and patched by each edit.
   */
  const [bible, setBible] = useState<aiApi.StoryBible | null>(null)
  const [seededFor, setSeededFor] = useState<string | null>(null)
  if (loaded.data && seededFor !== loaded.data.story.id) {
    setSeededFor(loaded.data.story.id)
    setBible(loaded.data.bible)
  }

  const [reading, setReading] = useState<{ done: number; total: number } | null>(null)
  const stopReading = useRef<AbortController | null>(null)

  const [filter, setFilter] = useState<KindFilter>('all')
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  /* Reading chapters --------------------------------------------------- */

  /**
   * One chapter per request until nothing is pending.
   *
   * A loop on this side rather than one long request: each call is short,
   * what it read stays read if the next one fails, and the count on screen is
   * real progress rather than a spinner.
   */
  async function onRead() {
    if (!bible) return

    const controller = new AbortController()
    stopReading.current = controller

    const total = bible.pending
    let done = 0
    setReading({ done, total })

    try {
      let current = bible
      while (current.pending > 0 && !controller.signal.aborted) {
        const result = await aiApi.refreshStoryBible(current.storyId, controller.signal)
        current = result.bible
        done += result.processed.length
        setBible(current)
        setReading({ done, total })

        // Nothing was read though something is pending: stop rather than spin.
        if (result.processed.length === 0) break
      }

      if (!controller.signal.aborted) {
        showToast({ message: 'Your story bible is up to date.' })
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        showToast({
          tone: 'error',
          message: messageFor(
            cause,
            'Reading stopped. What was read so far has been kept.',
          ),
        })
      }
    } finally {
      setReading(null)
      stopReading.current = null
    }
  }

  /* Editing facts ------------------------------------------------------- */

  function replaceFact(next: aiApi.StoryFact) {
    setBible((current) =>
      current
        ? {
            ...current,
            facts: current.facts.map((fact) => (fact.id === next.id ? next : fact)),
          }
        : current,
    )
  }

  async function onSaveEdit(fact: aiApi.StoryFact, draft: FactFields) {
    setBusy(fact.id)
    try {
      replaceFact(
        await aiApi.updateStoryFact(fact.id, {
          subject: draft.subject.trim(),
          attribute: draft.attribute.trim(),
          value: draft.value.trim(),
        }),
      )
      setEditing(null)
    } catch (cause) {
      showToast({
        tone: 'error',
        message: messageFor(cause, 'That fact could not be saved.'),
      })
    } finally {
      setBusy(null)
    }
  }

  async function onRemove(fact: aiApi.StoryFact) {
    setBusy(fact.id)
    try {
      await aiApi.removeStoryFact(fact.id)
      setBible((current) =>
        current
          ? { ...current, facts: current.facts.filter((item) => item.id !== fact.id) }
          : current,
      )
    } catch (cause) {
      showToast({
        tone: 'error',
        message: messageFor(cause, 'That fact could not be removed.'),
      })
    } finally {
      setBusy(null)
    }
  }

  async function onAdd(draft: aiApi.FactDraft): Promise<boolean> {
    if (!bible) return false

    try {
      const fact = await aiApi.addStoryFact(bible.storyId, draft)
      setBible((current) =>
        current ? { ...current, facts: [...current.facts, fact] } : current,
      )
      return true
    } catch (cause) {
      showToast({
        tone: 'error',
        message: messageFor(cause, 'That fact could not be added.'),
      })
      return false
    }
  }

  /* Grouping ------------------------------------------------------------ */

  // One person under one heading, whichever of their names a chapter used.
  const groups = useMemo(
    () =>
      groupBySubject(bible?.facts ?? [], (fact) => filter === 'all' || fact.kind === filter),
    [bible, filter],
  )

  /* Render -------------------------------------------------------------- */

  if (loaded.status === 'loading') {
    return (
      <div className="bible__loading">
        <Skeleton height="2.5rem" width="40%" />
        <Skeleton height="8rem" />
        <Skeleton height="14rem" />
      </div>
    )
  }

  if (loaded.status === 'error' || !loaded.data || !bible) {
    return (
      <ErrorState
        title="That story bible could not be opened"
        message={loaded.error ?? 'It may not be your story, or it may be gone.'}
        onRetry={loaded.reload}
      />
    )
  }

  const { story } = loaded.data
  const read = bible.chapters.filter((chapter) => chapter.state === 'current').length
  const total = bible.chapters.length
  const dropped = bible.chapters.reduce((sum, chapter) => sum + chapter.droppedCount, 0)

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-head__title">Story bible</h1>
          <p className="page-head__sub">
            What <strong>{story.title}</strong> has established so far, read
            from your own chapters. The writing assistant is shown the relevant
            facts, and new chapters are checked against them.
          </p>
        </div>
        <ButtonLink
          to={`/author/stories/${story.slug}`}
          startIcon={<Icon name="arrow-left" size="1em" />}
        >
          Back to the editor
        </ButtonLink>
      </header>

      {/* Chapters --------------------------------------------------------- */}
      <Card className="bible__chapters">
        <div className="bible__chapters-head">
          <div>
            <h2 className="bible__section-title">Chapters</h2>
            <p className="bible__note">
              {total === 0
                ? 'This story has no chapters to read yet.'
                : `${read} of ${total} read.`}
              {bible.pending > 0 && total > 0
                ? ` ${bible.pending} ${bible.pending === 1 ? 'is' : 'are'} new or changed.`
                : ''}
            </p>
          </div>

          {reading ? (
            <div className="bible__reading">
              <span aria-live="polite">
                Reading chapter {Math.min(reading.done + 1, reading.total)} of{' '}
                {reading.total}…
              </span>
              <Button size="sm" onClick={() => stopReading.current?.abort()}>
                Stop
              </Button>
            </div>
          ) : (
            <Button
              variant="primary"
              disabled={bible.pending === 0}
              onClick={() => void onRead()}
              startIcon={<Icon name="sparkle" size="1em" />}
            >
              {bible.pending === 0
                ? 'Up to date'
                : `Read ${bible.pending} ${bible.pending === 1 ? 'chapter' : 'chapters'}`}
            </Button>
          )}
        </div>

        {total > 0 ? (
          <ol className="bible__chapter-list">
            {bible.chapters.map((chapter) => (
              <li key={chapter.chapterId} className="bible__chapter">
                <span className="bible__chapter-title">
                  {chapter.chapterNumber}. {chapter.title || 'Untitled chapter'}
                </span>
                <span className="bible__chapter-meta">
                  {chapter.state === 'missing'
                    ? null
                    : `${chapter.factCount} ${chapter.factCount === 1 ? 'fact' : 'facts'}`}
                  {chapter.truncated ? ' · long chapter, end not read' : ''}
                </span>
                <StatusBadge
                  tone={
                    chapter.state === 'current'
                      ? 'success'
                      : chapter.state === 'stale'
                        ? 'warning'
                        : 'neutral'
                  }
                >
                  {STATE_LABELS[chapter.state]}
                </StatusBadge>
              </li>
            ))}
          </ol>
        ) : null}

        <p className="bible__note">
          Facts are extracted by AI and can be wrong. Each one shows the
          sentence it came from; correct or remove anything that is not right,
          and your version is kept when the chapter is read again.
          {dropped > 0
            ? ` ${dropped} suggested ${dropped === 1 ? 'fact was' : 'facts were'} discarded because the chapter did not actually say ${dropped === 1 ? 'it' : 'them'}.`
            : ''}
        </p>
      </Card>

      {/* Facts ------------------------------------------------------------ */}
      <section className="page-section">
        <div className="bible__facts-head">
          <h2 className="bible__section-title">Facts</h2>
          <SegmentedControl
            label="Kind of fact"
            size="sm"
            items={KIND_FILTERS}
            value={filter}
            onChange={setFilter}
          />
        </div>

        {groups.length === 0 ? (
          <EmptyState
            icon="book-open"
            size="sm"
            title={bible.facts.length === 0 ? 'No facts yet' : 'Nothing of that kind'}
            description={
              bible.facts.length === 0
                ? 'Read your chapters above, or add a fact yourself below.'
                : 'Try another filter.'
            }
          />
        ) : (
          <div className="bible__groups">
            {groups.map(({ name, aliases, facts }) => (
              <Card key={name} as="section" className="bible__group">
                <h3 className="bible__subject">{name}</h3>
                {aliases.length > 0 ? (
                  <p className="bible__aliases">Also called {aliases.join(', ')}</p>
                ) : null}
                <ul className="bible__fact-list">
                  {facts.map((fact) => (
                    <li key={fact.id} className="bible__fact">
                      {editing === fact.id ? (
                        <FactEditor
                          fact={fact}
                          saving={busy === fact.id}
                          onCancel={() => setEditing(null)}
                          onSave={(draft) => void onSaveEdit(fact, draft)}
                        />
                      ) : (
                        <>
                          <div className="bible__fact-main">
                            <p className="bible__claim">
                              <span className="bible__attribute">{fact.attribute}</span>
                              {fact.value}
                              {fact.related ? (
                                <span className="bible__related"> · with {fact.related}</span>
                              ) : null}
                            </p>
                            <div className="bible__fact-actions">
                              <Button
                                size="sm"
                                variant="ghost"
                                iconOnly
                                aria-label={`Correct “${fact.attribute}”`}
                                onClick={() => setEditing(fact.id)}
                                startIcon={<Icon name="pencil" size="0.95rem" />}
                              />
                              <Button
                                size="sm"
                                variant="ghost"
                                iconOnly
                                aria-label={`Remove “${fact.attribute}”`}
                                loading={busy === fact.id}
                                onClick={() => void onRemove(fact)}
                                startIcon={<Icon name="trash" size="0.95rem" />}
                              />
                            </div>
                          </div>

                          {fact.quote ? (
                            <blockquote className="bible__quote">{fact.quote}</blockquote>
                          ) : null}

                          <p className="bible__source">
                            {sourceOf(fact)}
                            {/*
                              Whose claim this is, on every row: an author's
                              own words and a model's reading of them are
                              never shown as the same kind of thing.
                            */}
                            <StatusBadge tone={fact.origin === 'author' ? 'brand' : 'neutral'}>
                              {fact.origin === 'author' ? 'Yours' : 'AI reading'}
                            </StatusBadge>
                          </p>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* Add one ---------------------------------------------------------- */}
      <section className="page-section">
        <h2 className="bible__section-title">Add a fact</h2>
        <FactComposer chapters={bible.chapters} onAdd={onAdd} />
      </section>
    </>
  )
}

/* Editing one fact ------------------------------------------------------- */

interface FactFields {
  subject: string
  attribute: string
  value: string
}

function FactEditor({
  fact,
  saving,
  onSave,
  onCancel,
}: {
  fact: aiApi.StoryFact
  saving: boolean
  onSave: (draft: FactFields) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<FactFields>({
    subject: fact.subject,
    attribute: fact.attribute,
    value: fact.value,
  })

  const complete =
    draft.subject.trim() !== '' && draft.attribute.trim() !== '' && draft.value.trim() !== ''

  return (
    <form
      className="bible__editor"
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        if (complete) onSave(draft)
      }}
    >
      <div className="bible__editor-grid">
        <TextField
          label="About"
          value={draft.subject}
          maxLength={80}
          onChange={(event) => setDraft({ ...draft, subject: event.target.value })}
        />
        <TextField
          label="What"
          value={draft.attribute}
          maxLength={60}
          onChange={(event) => setDraft({ ...draft, attribute: event.target.value })}
        />
        <TextField
          label="Fact"
          value={draft.value}
          maxLength={300}
          onChange={(event) => setDraft({ ...draft, value: event.target.value })}
        />
      </div>
      <div className="bible__editor-actions">
        <Button type="submit" variant="primary" size="sm" loading={saving} disabled={!complete}>
          Save correction
        </Button>
        <Button type="button" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <p className="bible__note">
          A corrected fact becomes yours and is kept when the chapter is read again.
        </p>
      </div>
    </form>
  )
}

/* Adding a fact ---------------------------------------------------------- */

function FactComposer({
  chapters,
  onAdd,
}: {
  chapters: aiApi.ChapterBibleStatus[]
  onAdd: (draft: aiApi.FactDraft) => Promise<boolean>
}) {
  const [kind, setKind] = useState<aiApi.FactKind>('character')
  const [subject, setSubject] = useState('')
  const [attribute, setAttribute] = useState('')
  const [value, setValue] = useState('')
  const [related, setRelated] = useState('')
  const [chapterId, setChapterId] = useState('')
  const [adding, setAdding] = useState(false)

  const complete =
    subject.trim() !== '' &&
    attribute.trim() !== '' &&
    value.trim() !== '' &&
    (kind !== 'relationship' || related.trim() !== '')

  const chapterOptions = [
    { value: '', label: 'The whole story' },
    ...chapters.map((chapter) => ({
      value: chapter.chapterId,
      label: `From chapter ${chapter.chapterNumber}: ${chapter.title || 'Untitled'}`,
    })),
  ]

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!complete) return

    setAdding(true)
    const added = await onAdd({
      kind,
      subject: subject.trim(),
      attribute: attribute.trim(),
      value: value.trim(),
      related: kind === 'relationship' ? related.trim() : null,
      chapterId: chapterId === '' ? null : chapterId,
    })
    setAdding(false)

    // The subject stays: facts are usually added several at a time about the
    // same person.
    if (added) {
      setAttribute('')
      setValue('')
      setRelated('')
    }
  }

  return (
    <Card className="bible__composer">
      <form onSubmit={(event) => void onSubmit(event)}>
        <div className="bible__composer-grid">
          <Select label="Kind" value={kind} options={KIND_OPTIONS} onChange={setKind} />
          <TextField
            label="About"
            value={subject}
            maxLength={80}
            placeholder="Mira Desai"
            onChange={(event) => setSubject(event.target.value)}
          />
          {kind === 'relationship' ? (
            <TextField
              label="With"
              value={related}
              maxLength={80}
              placeholder="Arjun"
              onChange={(event) => setRelated(event.target.value)}
            />
          ) : null}
          <TextField
            label="What"
            value={attribute}
            maxLength={60}
            placeholder={kind === 'relationship' ? 'sister of' : 'eye colour'}
            onChange={(event) => setAttribute(event.target.value)}
          />
          <TextField
            label="Fact"
            value={value}
            maxLength={300}
            placeholder={kind === 'relationship' ? 'older sister' : 'green'}
            onChange={(event) => setValue(event.target.value)}
          />
          <Select
            label="True for"
            value={chapterId}
            options={chapterOptions}
            onChange={setChapterId}
          />
        </div>
        <div className="bible__editor-actions">
          <Button
            type="submit"
            variant="primary"
            loading={adding}
            disabled={!complete}
            startIcon={<Icon name="plus" size="1em" />}
          >
            Add fact
          </Button>
          <p className="bible__note">
            For things you know and no chapter says yet. Yours are never
            overwritten.
          </p>
        </div>
      </form>
    </Card>
  )
}
