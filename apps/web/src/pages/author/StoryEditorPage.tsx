import { useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAsync } from '../../hooks/useAsync'
import { cn } from '../../lib/cn'
import { useToast } from '../../lib/toast'
import { formatCount, readingMinutes } from '../../lib/format'
import * as api from '../../data/api'
import type { MultimediaKind, StoryStatus } from '../../types/domain'
import { AppShell } from '../../components/layout/AppShell'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { SelectableChip, StatusBadge } from '../../components/ui/Chip'
import { ConfirmDialog, Dialog } from '../../components/ui/Dialog'
import { Icon, type IconName } from '../../components/ui/Icon'
import { Select } from '../../components/ui/Select'
import { Switch } from '../../components/ui/Checkbox'
import { SegmentedControl } from '../../components/ui/Tabs'
import { TextField } from '../../components/ui/TextField'
import { InlineNotice } from '../../components/ui/States'
import { StoryCover } from '../../components/story/StoryCover'
import { countWords, renderMarkdown } from './markdown'
import '../pages.css'
import './author.css'

interface DraftChapter {
  id: string
  title: string
  body: string
  published: boolean
}

const STATUS_OPTIONS: ReadonlyArray<{ value: StoryStatus; label: string }> = [
  { value: 'draft', label: 'Draft — only you can see it' },
  { value: 'ongoing', label: 'Ongoing — publishing chapters' },
  { value: 'completed', label: 'Completed — the whole story is up' },
  { value: 'hiatus', label: 'On hiatus — paused for now' },
]

interface ToolbarButton {
  icon: IconName
  label: string
  /** Wraps the selection, or inserts at the caret when nothing is selected. */
  wrap?: [string, string]
  prefix?: string
}

const TOOLBAR: ToolbarButton[] = [
  { icon: 'type', label: 'Heading', prefix: '# ' },
  { icon: 'text-size', label: 'Subheading', prefix: '## ' },
  { icon: 'pen', label: 'Bold', wrap: ['**', '**'] },
  { icon: 'quote', label: 'Italic', wrap: ['*', '*'] },
  { icon: 'list', label: 'Bullet list', prefix: '- ' },
  { icon: 'columns', label: 'Block quote', prefix: '> ' },
]

const MEDIA_KINDS: ReadonlyArray<{ kind: MultimediaKind; icon: IconName; label: string }> = [
  { kind: 'image', icon: 'image', label: 'Image' },
  { kind: 'audio', icon: 'audio', label: 'Audio' },
  { kind: 'video', icon: 'video', label: 'Video' },
]

export function StoryEditorPage() {
  const { slug } = useParams()
  const isNew = !slug || slug === 'new'
  const navigate = useNavigate()
  const { showToast } = useToast()

  const existing = useAsync(
    () => (isNew ? Promise.resolve(null) : api.getStory(slug)),
    [slug],
  )
  const genres = useAsync(() => api.getGenres(), [])
  const existingChapters = useAsync(
    () =>
      existing.data ? api.getChapters(existing.data.id) : Promise.resolve([]),
    [existing.data?.id],
  )

  /* Story metadata ---------------------------------------------------- */
  const [title, setTitle] = useState('')
  const [synopsis, setSynopsis] = useState('')
  const [genreIds, setGenreIds] = useState<string[]>([])
  const [kidsAppropriate, setKidsAppropriate] = useState(false)
  const [status, setStatus] = useState<StoryStatus>('draft')

  /* Chapters ---------------------------------------------------------- */
  const [chapters, setChapters] = useState<DraftChapter[]>([
    { id: 'c1', title: 'The Beginning', body: '', published: false },
  ])
  const [activeId, setActiveId] = useState('c1')
  const [mode, setMode] = useState<'write' | 'preview'>('write')

  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [mediaOpen, setMediaOpen] = useState(false)
  const [mediaKind, setMediaKind] = useState<MultimediaKind>('image')
  const [mediaCaption, setMediaCaption] = useState('')
  const [confirmPublish, setConfirmPublish] = useState(false)

  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const active = chapters.find((chapter) => chapter.id === activeId) ?? chapters[0]!

  // Seed the form from an existing story once it arrives.
  const [seeded, setSeeded] = useState(false)
  if (!seeded && existing.data) {
    setSeeded(true)
    setTitle(existing.data.title)
    setSynopsis(existing.data.synopsis)
    setGenreIds(existing.data.genreIds)
    setKidsAppropriate(existing.data.kidsAppropriate)
    setStatus(existing.data.status)
  }
  if (!seeded && existingChapters.data && existingChapters.data.length > 0) {
    const loaded = existingChapters.data.slice(0, 6).map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      body: chapter.paragraphs.join('\n\n'),
      published: chapter.publishedAt !== null,
    }))
    setChapters(loaded)
    setActiveId(loaded[0]!.id)
  }

  function patchChapter(id: string, patch: Partial<DraftChapter>) {
    setChapters((current) =>
      current.map((chapter) => (chapter.id === id ? { ...chapter, ...patch } : chapter)),
    )
    setDirty(true)
  }

  /** Applies a toolbar action to the current selection. */
  function applyFormat(button: ToolbarButton) {
    const field = bodyRef.current
    if (!field) return

    const { selectionStart, selectionEnd, value } = field
    const selected = value.slice(selectionStart, selectionEnd)

    let next: string
    let caret: number

    if (button.wrap) {
      const [before, after] = button.wrap
      next = `${value.slice(0, selectionStart)}${before}${selected}${after}${value.slice(selectionEnd)}`
      caret = selectionEnd + before.length + after.length
    } else {
      const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1
      next = `${value.slice(0, lineStart)}${button.prefix}${value.slice(lineStart)}`
      caret = selectionEnd + (button.prefix?.length ?? 0)
    }

    patchChapter(active.id, { body: next })
    requestAnimationFrame(() => {
      field.focus()
      field.setSelectionRange(caret, caret)
    })
  }

  function insertMedia() {
    if (mediaCaption.trim().length === 0) {
      setErrors((current) => ({ ...current, media: 'Add a caption so readers know what it is.' }))
      return
    }

    const token = `\n\n[${mediaKind}: ${mediaCaption.trim()}]\n\n`
    patchChapter(active.id, { body: `${active.body}${token}` })
    setMediaOpen(false)
    setMediaCaption('')
    setErrors((current) => ({ ...current, media: '' }))
    showToast({ message: `${mediaKind} placeholder added to the chapter.` })
  }

  function addChapter() {
    const id = `c${Date.now()}`
    setChapters((current) => [
      ...current,
      { id, title: `Chapter ${current.length + 1}`, body: '', published: false },
    ])
    setActiveId(id)
    setDirty(true)
  }

  function moveChapter(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= chapters.length) return

    setChapters((current) => {
      const next = [...current]
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved!)
      return next
    })
    setDirty(true)
  }

  function validate(): Record<string, string> {
    const next: Record<string, string> = {}
    if (title.trim().length === 0) next.title = 'Your story needs a title.'
    if (synopsis.trim().length < 20) next.synopsis = 'Write at least a sentence or two.'
    if (genreIds.length === 0) next.genres = 'Pick at least one genre.'
    if (active.title.trim().length === 0) next.chapterTitle = 'Give this chapter a title.'
    return next
  }

  async function onSaveDraft() {
    const next = validate()
    // A draft only needs a title — the rest can wait.
    const blocking: Record<string, string> = next.title ? { title: next.title } : {}
    setErrors(blocking)
    if (Object.keys(blocking).length > 0) return

    setSaving(true)
    try {
      await new Promise((resolve) => setTimeout(resolve, 600))
      setDirty(false)
      setSavedAt(new Date().toISOString())
      showToast({ message: 'Draft saved.' })
    } catch {
      showToast({ tone: 'error', message: 'We could not save your draft. Your text is still here.' })
    } finally {
      setSaving(false)
    }
  }

  async function onPublish() {
    const next = validate()
    setErrors(next)
    setConfirmPublish(false)
    if (Object.keys(next).length > 0) {
      showToast({ tone: 'error', message: 'A few details need fixing before publishing.' })
      return
    }

    setPublishing(true)
    try {
      await new Promise((resolve) => setTimeout(resolve, 800))
      setDirty(false)
      showToast({ message: `“${title}” published. Your subscribers have been notified.` })
      navigate('/author/stories')
    } catch {
      showToast({ tone: 'error', message: 'Publishing failed. Your draft is safe.' })
    } finally {
      setPublishing(false)
    }
  }

  const words = countWords(active.body)

  return (
    <AppShell variant="author">
      {/* Studio header --------------------------------------------------- */}
      <header className="editor__head">
        <div className="editor__head-main">
          <p className="editor__crumb">
            {isNew ? 'New story' : 'Editing'} ·{' '}
            <StatusBadge tone={status === 'draft' ? 'neutral' : 'brand'}>{status}</StatusBadge>
          </p>
          <input
            className="editor__title-input"
            value={title}
            placeholder="Untitled story"
            aria-label="Story title"
            maxLength={120}
            onChange={(event) => {
              setTitle(event.target.value)
              setErrors((current) => ({ ...current, title: '' }))
              setDirty(true)
            }}
          />
          {errors.title ? <p className="editor__error">{errors.title}</p> : null}
        </div>

        <div className="editor__head-actions">
          <span className="editor__save-state" aria-live="polite">
            {dirty ? 'Unsaved changes' : savedAt ? 'All changes saved' : ''}
          </span>
          <Button loading={saving} onClick={onSaveDraft} startIcon={<Icon name="check" size="1em" />}>
            Save draft
          </Button>
          <Button
            onClick={() => setMode(mode === 'write' ? 'preview' : 'write')}
            startIcon={<Icon name="eye" size="1em" />}
          >
            {mode === 'write' ? 'Preview' : 'Back to writing'}
          </Button>
          <Button
            variant="primary"
            loading={publishing}
            onClick={() => setConfirmPublish(true)}
            startIcon={<Icon name="upload" size="1em" />}
          >
            Publish
          </Button>
        </div>
      </header>

      <div className="editor">
        {/* Chapter editor ---------------------------------------------- */}
        <div className="editor__main">
          <Card className="editor__chapter">
            <TextField
              label="Chapter title"
              value={active.title}
              error={errors.chapterTitle}
              maxLength={120}
              onChange={(event) => {
                patchChapter(active.id, { title: event.target.value })
                setErrors((current) => ({ ...current, chapterTitle: '' }))
              }}
            />

            <div className="editor__toolbar" role="toolbar" aria-label="Formatting">
              {TOOLBAR.map((button) => (
                <Button
                  key={button.label}
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label={button.label}
                  title={button.label}
                  onClick={() => applyFormat(button)}
                  startIcon={<Icon name={button.icon} size="1rem" />}
                />
              ))}

              <span className="editor__toolbar-divider" role="separator" />

              {MEDIA_KINDS.map((media) => (
                <Button
                  key={media.kind}
                  variant="ghost"
                  size="sm"
                  aria-label={`Insert ${media.label.toLowerCase()}`}
                  onClick={() => {
                    setMediaKind(media.kind)
                    setMediaOpen(true)
                  }}
                  startIcon={<Icon name={media.icon} size="1rem" />}
                >
                  {media.label}
                </Button>
              ))}
            </div>

            {mode === 'write' ? (
              <>
                <label className="visually-hidden" htmlFor="chapter-body">
                  Chapter text
                </label>
                <textarea
                  id="chapter-body"
                  ref={bodyRef}
                  className="editor__body"
                  value={active.body}
                  placeholder="Start writing the chapter. Use the toolbar for headings, emphasis and media."
                  onChange={(event) => patchChapter(active.id, { body: event.target.value })}
                />
              </>
            ) : (
              <div className="preview">
                <h1>{active.title || 'Untitled chapter'}</h1>
                {active.body.trim().length === 0 ? (
                  <p className="preview__empty">Nothing to preview yet.</p>
                ) : (
                  renderMarkdown(active.body)
                )}
              </div>
            )}

            <footer className="editor__foot">
              <span>
                {formatCount(words)} words · {readingMinutes(words)} min read
              </span>
              <span>Markdown-style formatting: **bold**, *italic*, # heading, - list</span>
            </footer>
          </Card>
        </div>

        {/* Side panel --------------------------------------------------- */}
        <aside className="editor__side">
          {/* Chapters + ordering */}
          <Card>
            <div className="editor__side-head">
              <h2>Chapters</h2>
              <Button
                size="sm"
                variant="subtle"
                onClick={addChapter}
                startIcon={<Icon name="plus" size="0.95em" />}
              >
                Add
              </Button>
            </div>

            <ol className="chapter-manager">
              {chapters.map((chapter, index) => (
                <li key={chapter.id} className={cn(chapter.id === activeId && 'is-active')}>
                  <button
                    type="button"
                    className="chapter-manager__pick"
                    onClick={() => setActiveId(chapter.id)}
                  >
                    <span className="chapter-manager__num">{index + 1}</span>
                    <span className="chapter-manager__title">
                      {chapter.title || 'Untitled'}
                    </span>
                    {chapter.published ? (
                      <StatusBadge tone="success">Live</StatusBadge>
                    ) : (
                      <StatusBadge tone="neutral">Draft</StatusBadge>
                    )}
                  </button>
                  <span className="chapter-manager__order">
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Move ${chapter.title} earlier`}
                      disabled={index === 0}
                      onClick={() => moveChapter(index, -1)}
                      startIcon={<Icon name="chevron-up" size="0.9rem" />}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Move ${chapter.title} later`}
                      disabled={index === chapters.length - 1}
                      onClick={() => moveChapter(index, 1)}
                      startIcon={<Icon name="chevron-down" size="0.9rem" />}
                    />
                  </span>
                </li>
              ))}
            </ol>
          </Card>

          {/* Story details */}
          <Card>
            <h2 className="editor__side-title">Story details</h2>

            <div className="stack" style={{ gap: 'var(--space-5)' }}>
              <div className="editor__cover">
                <StoryCover
                  story={{
                    id: slug ?? 'new',
                    title: title || 'Untitled story',
                    genres: genres.data?.filter((genre) => genreIds.includes(genre.id)) ?? [],
                    author: { displayName: 'You' },
                  }}
                  size="lg"
                />
                <div>
                  <p className="editor__cover-note">
                    Covers are generated from your title and genre until you
                    upload artwork.
                  </p>
                  <Button size="sm" startIcon={<Icon name="upload" size="0.95em" />}>
                    Upload cover
                  </Button>
                </div>
              </div>

              <TextField
                multiline
                label="Description"
                placeholder="What is this story about? This is what readers see first."
                rows={4}
                value={synopsis}
                error={errors.synopsis}
                maxLength={1200}
                counterMax={1200}
                onChange={(event) => {
                  setSynopsis(event.target.value)
                  setErrors((current) => ({ ...current, synopsis: '' }))
                  setDirty(true)
                }}
              />

              <div>
                <p className="editor__label">Genres</p>
                {errors.genres ? <p className="editor__error">{errors.genres}</p> : null}
                <div className="chip-row">
                  {genres.data?.map((genre) => (
                    <SelectableChip
                      key={genre.id}
                      hue={genre.hue}
                      selected={genreIds.includes(genre.id)}
                      onToggle={() => {
                        setGenreIds((current) =>
                          current.includes(genre.id)
                            ? current.filter((id) => id !== genre.id)
                            : [...current, genre.id],
                        )
                        setErrors((current) => ({ ...current, genres: '' }))
                        setDirty(true)
                      }}
                    >
                      {genre.name}
                    </SelectableChip>
                  ))}
                </div>
              </div>

              <Switch
                checked={kidsAppropriate}
                onChange={(value) => {
                  setKidsAppropriate(value)
                  setDirty(true)
                }}
                label="Kid-appropriate"
                description="Shown to readers filtering for younger audiences."
              />

              <Select
                label="Publishing status"
                value={status}
                options={STATUS_OPTIONS}
                onChange={(value) => {
                  setStatus(value)
                  setDirty(true)
                }}
              />
            </div>
          </Card>
        </aside>
      </div>

      {/* Insert media -------------------------------------------------- */}
      <Dialog
        open={mediaOpen}
        onClose={() => setMediaOpen(false)}
        title={`Insert ${mediaKind}`}
        description="Attach media to this chapter. Readers see it inline while reading."
        size="sm"
        footer={
          <>
            <Button onClick={() => setMediaOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={insertMedia}>
              Insert
            </Button>
          </>
        }
      >
        <div className="stack" style={{ gap: 'var(--space-5)' }}>
          <SegmentedControl
            label="Media type"
            value={mediaKind}
            onChange={setMediaKind}
            items={MEDIA_KINDS.map((media) => ({
              value: media.kind,
              label: media.label,
              icon: <Icon name={media.icon} size="1rem" />,
            }))}
          />

          <div className="editor__upload">
            <Icon name="upload" size="1.5rem" />
            <p>Drag a file here, or choose one from your device</p>
            <Button size="sm">Choose file</Button>
          </div>

          <TextField
            label="Caption"
            placeholder="Chapter plate — the coast at low water"
            value={mediaCaption}
            error={errors.media}
            maxLength={160}
            onChange={(event) => {
              setMediaCaption(event.target.value)
              setErrors((current) => ({ ...current, media: '' }))
            }}
          />

          <InlineNotice>
            Uploads will attach to the chapter once the media service is
            connected — the caption and placement are saved with your draft now.
          </InlineNotice>
        </div>
      </Dialog>

      <ConfirmDialog
        open={confirmPublish}
        title={`Publish “${title || 'Untitled story'}”?`}
        message="Your story becomes visible to every reader on Scribe, and subscribers to your channel are notified. You can unpublish later."
        confirmLabel="Publish now"
        tone="primary"
        pending={publishing}
        onConfirm={onPublish}
        onCancel={() => setConfirmPublish(false)}
      />
    </AppShell>
  )
}
