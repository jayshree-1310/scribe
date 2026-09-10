import { useEffect, useRef, useState } from 'react'
import { useBlocker, useNavigate, useParams } from 'react-router-dom'
import { useAsync } from '../../hooks/useAsync'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { cn } from '../../lib/cn'
import { useToast } from '../../lib/toast'
import { ApiError } from '../../lib/api-client'
import { formatCount, readingMinutes } from '../../lib/format'
import * as storiesApi from '../../data/stories-api'
import * as authoringApi from '../../data/authoring-api'
import type { MultimediaKind } from '../../types/domain'
import { AppShell } from '../../components/layout/AppShell'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { SelectableChip, StatusBadge } from '../../components/ui/Chip'
import { ConfirmDialog, Dialog } from '../../components/ui/Dialog'
import { Icon, type IconName } from '../../components/ui/Icon'
import { Switch } from '../../components/ui/Checkbox'
import { SegmentedControl } from '../../components/ui/Tabs'
import { TextField } from '../../components/ui/TextField'
import { InlineNotice } from '../../components/ui/States'
import { Skeleton } from '../../components/ui/Skeleton'
import { ErrorState } from '../../components/ui/States'
import { CoverField } from '../../components/story/CoverField'
import { countWords, renderMarkdown } from './markdown'
import '../pages.css'
import './author.css'

/**
 * A chapter as the editor holds it.
 *
 * `key` is local and stable for the life of the tab, so React and the active
 * selection survive the chapter gaining a server `id` on its first save.
 * `dirty` is per chapter: a save then sends only what changed rather than
 * rewriting every body on every keystroke's debounce.
 */
interface DraftChapter {
  key: string
  id: string | null
  title: string
  body: string
  published: boolean
  dirty: boolean
}

let localKeys = 0

function blankChapter(number: number): DraftChapter {
  localKeys += 1
  return {
    key: `local-${localKeys}`,
    id: null,
    title: `Chapter ${number}`,
    body: '',
    published: false,
    dirty: true,
  }
}

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

/** What the file picker offers for each media kind. */
const MEDIA_ACCEPT: Record<MultimediaKind, string> = {
  image: 'image/*',
  audio: 'audio/*',
  video: 'video/*',
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let size = bytes / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`
}

/** How long typing has to settle before a draft is saved. */
const AUTOSAVE_MS = 1500

function messageFor(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.message : fallback
}

export function StoryEditorPage() {
  const { slug } = useParams()
  const isNew = !slug || slug === 'new'
  const navigate = useNavigate()
  const { showToast } = useToast()

  /**
   * Story and chapters in one pass. The story comes from the public endpoint
   * because that is what resolves a slug; the chapters come from the authoring
   * endpoint because the editor needs the prose, which the reader's chapter
   * list deliberately omits.
   */
  const loaded = useAsync(async () => {
    if (isNew || !slug) return null

    const story = await storiesApi.getStory(slug)
    const chapters = await authoringApi.listMyChapters(story.id)
    return { story, chapters }
  }, [slug])

  // Genres are real rows in `content.Genre`, served with story counts.
  const genres = useAsync(() => storiesApi.getGenres(), [])

  /* Story metadata ---------------------------------------------------- */
  const [storyId, setStoryId] = useState<string | null>(null)
  const [listed, setListed] = useState(false)
  const [title, setTitle] = useState('')
  const [synopsis, setSynopsis] = useState('')
  const [genreIds, setGenreIds] = useState<string[]>([])
  const [kidsAppropriate, setKidsAppropriate] = useState(false)
  const [isCompleted, setIsCompleted] = useState(false)
  const [coverUrl, setCoverUrl] = useState<string | null>(null)

  /* Chapters ---------------------------------------------------------- */
  const [chapters, setChapters] = useState<DraftChapter[]>([blankChapter(1)])
  const [activeKey, setActiveKey] = useState<string>(() => chapters[0]!.key)
  const [orderDirty, setOrderDirty] = useState(false)
  const [mode, setMode] = useState<'write' | 'preview'>('write')

  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [mediaOpen, setMediaOpen] = useState(false)
  const [mediaKind, setMediaKind] = useState<MultimediaKind>('image')
  const [mediaCaption, setMediaCaption] = useState('')
  const [mediaFile, setMediaFile] = useState<File | null>(null)
  const [dropping, setDropping] = useState(false)
  const [confirmPublish, setConfirmPublish] = useState(false)

  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const mediaInputRef = useRef<HTMLInputElement>(null)
  const active = chapters.find((chapter) => chapter.key === activeKey) ?? chapters[0]!

  /**
   * Seed the form from the loaded story.
   *
   * During render rather than in an effect — the pattern React recommends for
   * state derived from a changing input, and the one `useAsync` itself uses.
   * Story and chapters arrive from the same request, so one flag covers both
   * and the form can never show half of a story.
   */
  const [seededId, setSeededId] = useState<string | null>(null)
  if (loaded.data && seededId !== loaded.data.story.id) {
    const { story, chapters: loadedChapters } = loaded.data

    const seeded: DraftChapter[] =
      loadedChapters.length > 0
        ? loadedChapters.map((chapter) => ({
            key: `server-${chapter.id}`,
            id: chapter.id,
            title: chapter.title,
            body: chapter.content,
            published: chapter.publishedAt !== null,
            dirty: false,
          }))
        : [blankChapter(1)]

    setSeededId(story.id)
    setStoryId(story.id)
    setListed(story.listedAt !== null)
    setTitle(story.title)
    setSynopsis(story.description ?? '')
    setGenreIds(story.genres.map((genre) => genre.id))
    setKidsAppropriate(story.kidsAppropriate)
    setIsCompleted(story.isCompleted)
    setCoverUrl(story.coverUrl)
    setChapters(seeded)
    setActiveKey(seeded[0]!.key)
    setOrderDirty(false)
    setDirty(false)
  }

  function patchChapter(key: string, patch: Partial<DraftChapter>) {
    setChapters((current) =>
      current.map((chapter) =>
        chapter.key === key ? { ...chapter, ...patch, dirty: true } : chapter,
      ),
    )
    setDirty(true)
  }

  /* Saving ------------------------------------------------------------- */

  /**
   * Pushes the whole form to the API.
   *
   * Returns the story's id and the chapters as they now stand on the server —
   * a caller that has just created a chapter needs its new id, and the state
   * it can read is a render behind.
   *
   * One pipeline for autosave, "Save draft" and publish, so there is a single
   * order of operations: the story first (it has to exist before a chapter can
   * hang off it), then chapter bodies, then the ordering. The reorder goes
   * last and only when it has to, because it rewrites every chapter number.
   */
  async function save(
    options: { silent?: boolean } = {},
  ): Promise<{ storyId: string; chapters: DraftChapter[] } | null> {
    const trimmed = title.trim()
    if (trimmed.length === 0) {
      setErrors((current) => ({ ...current, title: 'Your story needs a title.' }))
      return null
    }

    setSaving(true)
    try {
      const draft = {
        title: trimmed,
        description: synopsis.trim(),
        genreIds,
        kidsAppropriate,
        isCompleted,
      }

      let id = storyId
      if (id === null) {
        const created = await authoringApi.createStory(draft)
        id = created.id
        setStoryId(created.id)
        setListed(created.listedAt !== null)
        setCoverUrl(created.coverUrl)
      } else {
        const updated = await authoringApi.updateStory(id, draft)
        setListed(updated.listedAt !== null)
      }

      // Sequential rather than parallel: a chapter created here lands at the
      // end of the story, so the requests going out in order is what makes
      // the server's order match the author's before any reorder.
      let created = false
      const saved: DraftChapter[] = []

      for (const chapter of chapters) {
        if (chapter.id === null) {
          const fresh = await authoringApi.createChapter(id, {
            title: chapter.title.trim() || 'Untitled chapter',
            content: chapter.body,
          })
          created = true
          saved.push({ ...chapter, id: fresh.id, dirty: false })
        } else if (chapter.dirty) {
          await authoringApi.updateChapter(chapter.id, {
            title: chapter.title.trim() || 'Untitled chapter',
            content: chapter.body,
          })
          saved.push({ ...chapter, dirty: false })
        } else {
          saved.push(chapter)
        }
      }

      if ((orderDirty || created) && saved.length > 1) {
        await authoringApi.reorderChapters(
          id,
          saved.map((chapter) => chapter.id!),
        )
      }

      // Merged rather than assigned, so only the server id and the `dirty`
      // flag come from `saved`.
      setChapters((current) =>
        current.map((chapter) => {
          const match = saved.find((entry) => entry.key === chapter.key)
          if (!match) return chapter
          // `dirty` is recomputed rather than cleared: the author may have
          // typed during the round trip, and their newer text has to win over
          // what was sent.
          return {
            ...chapter,
            id: match.id,
            dirty:
              chapter.title !== match.title || chapter.body !== match.body,
          }
        }),
      )

      setOrderDirty(false)
      // The page-level flag only drives the "unsaved changes" label. A
      // keystroke that landed mid-flight is still tracked by the per-chapter
      // `dirty` above, so the next save sends it either way.
      setDirty(false)
      setSavedAt(new Date().toISOString())
      setErrors({})
      if (!options.silent) showToast({ message: 'Draft saved.' })

      return { storyId: id, chapters: saved }
    } catch (cause) {
      showToast({
        tone: 'error',
        message: messageFor(
          cause,
          'We could not save your draft. Your text is still here.',
        ),
      })
      return null
    } finally {
      setSaving(false)
    }
  }

  /**
   * Autosave.
   *
   * Only once the story exists: a create derives the slug from the title, so
   * saving a half-typed one would mint a URL nobody chose. The first save is
   * the author's own click, and everything after it is automatic.
   */
  const snapshot = JSON.stringify({
    title,
    synopsis,
    genreIds,
    kidsAppropriate,
    isCompleted,
    order: chapters.map((chapter) => chapter.key),
    chapters: chapters.map((chapter) => [chapter.title, chapter.body]),
  })
  const settled = useDebouncedValue(snapshot, AUTOSAVE_MS)

  /**
   * Held in a ref so the effect below can depend on the settled snapshot
   * alone. Depending on `save` itself would re-arm the autosave on every
   * keystroke — the closure is new each render — which is exactly what the
   * debounce exists to prevent.
   */
  const autosave = useRef(() => {})

  // Declared before the firing effect below, so the newest closure is in
  // place by the time that one runs -- the same ordering `useAsync` relies on.
  useEffect(() => {
    autosave.current = () => {
      if (storyId === null || !dirty || saving || publishing) return
      void save({ silent: true })
    }
  })

  useEffect(() => {
    autosave.current()
  }, [settled])

  /* Chapter actions ---------------------------------------------------- */

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

    patchChapter(active.key, { body: next })
    requestAnimationFrame(() => {
      field.focus()
      field.setSelectionRange(caret, caret)
    })
  }

  /**
   * Takes the picked or dropped file. The upload endpoint does not exist yet,
   * so the file is only held here and named back to the author — the caption
   * and placement are what actually get saved with the draft.
   */
  function chooseMediaFile(file: File | null) {
    if (!file) return
    setMediaFile(file)
    setErrors((current) => ({ ...current, media: '' }))
    // Offer the file name as a caption when there isn't one yet.
    if (mediaCaption.trim().length === 0) {
      setMediaCaption(file.name.replace(/\.[^.]+$/, '').slice(0, 160))
    }
  }

  /** Clears the dialog's own state so the next open starts fresh. */
  function closeMedia() {
    setMediaOpen(false)
    setMediaFile(null)
    setDropping(false)
    setErrors((current) => ({ ...current, media: '' }))
  }

  function insertMedia() {
    if (mediaCaption.trim().length === 0) {
      setErrors((current) => ({ ...current, media: 'Add a caption so readers know what it is.' }))
      return
    }

    const token = `\n\n[${mediaKind}: ${mediaCaption.trim()}]\n\n`
    patchChapter(active.key, { body: `${active.body}${token}` })
    setMediaCaption('')
    closeMedia()
    showToast({ message: `${mediaKind} placeholder added to the chapter.` })
  }

  function addChapter() {
    const chapter = blankChapter(chapters.length + 1)
    setChapters((current) => [...current, chapter])
    setActiveKey(chapter.key)
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
    setOrderDirty(true)
    setDirty(true)
  }

  const [chapterBusy, setChapterBusy] = useState<string | null>(null)

  /**
   * Publishes or withdraws one chapter.
   *
   * A chapter has to exist on the server first, so this saves whatever is
   * pending before it asks — otherwise an author would publish a chapter whose
   * latest paragraph is still only in the browser.
   */
  async function toggleChapter(chapter: DraftChapter) {
    setChapterBusy(chapter.key)
    try {
      let id = chapter.id

      if (id === null || chapter.dirty || dirty) {
        const result = await save({ silent: true })
        if (result === null) return
        id =
          result.chapters.find((entry) => entry.key === chapter.key)?.id ?? id
      }

      if (id === null) return

      const result = chapter.published
        ? await authoringApi.unpublishChapter(id)
        : await authoringApi.publishChapter(id)

      setChapters((current) =>
        current.map((entry) =>
          entry.key === chapter.key
            ? { ...entry, published: result.publishedAt !== null }
            : entry,
        ),
      )
    } catch (cause) {
      showToast({
        tone: 'error',
        message: messageFor(cause, 'We could not change that chapter.'),
      })
    } finally {
      setChapterBusy(null)
    }
  }

  async function removeChapter(chapter: DraftChapter) {
    // Never leave the story with no chapter at all: the editor has nothing to
    // show, and a story needs somewhere to write.
    if (chapters.length === 1) {
      showToast({ tone: 'error', message: 'A story needs at least one chapter.' })
      return
    }

    setChapterBusy(chapter.key)
    try {
      if (chapter.id !== null) await authoringApi.deleteChapter(chapter.id)

      setChapters((current) => {
        const next = current.filter((entry) => entry.key !== chapter.key)
        if (chapter.key === activeKey) setActiveKey(next[0]!.key)
        return next
      })

      showToast({ message: `“${chapter.title || 'Untitled'}” deleted.` })
    } catch (cause) {
      showToast({
        tone: 'error',
        message: messageFor(cause, 'We could not delete that chapter.'),
      })
    } finally {
      setChapterBusy(null)
    }
  }

  /**
   * Saves a cover the author just uploaded.
   *
   * The story has to exist before it can carry a cover, so an unsaved draft is
   * saved first — the same rule as publishing a chapter. Kept out of `save`'s
   * `draft` payload on purpose: the cover commits on its own, and sending a
   * stale `coverUrl` with every autosave would let a debounced save undo an
   * upload that landed a moment earlier.
   */
  async function onCoverChange(next: string | null) {
    let id = storyId
    if (id === null) {
      const result = await save({ silent: true })
      if (result === null) throw new ApiError('Give your story a title first.')
      id = result.storyId
    }

    const story = await authoringApi.updateStory(id, { coverUrl: next ?? '' })
    setCoverUrl(story.coverUrl)
  }

  /* Publishing --------------------------------------------------------- */

  function validate(): Record<string, string> {
    const next: Record<string, string> = {}
    if (title.trim().length === 0) next.title = 'Your story needs a title.'
    if (synopsis.trim().length < 20) next.synopsis = 'Write at least a sentence or two.'
    if (genreIds.length === 0) next.genres = 'Pick at least one genre.'
    if (active.title.trim().length === 0) next.chapterTitle = 'Give this chapter a title.'
    if (chapters.every((chapter) => chapter.body.trim().length === 0)) {
      next.chapterBody = 'Write a chapter before publishing.'
    }
    return next
  }

  async function onSaveDraft() {
    await save()
  }

  /**
   * Publishes the story.
   *
   * Every chapter with something in it goes live, then the story is listed —
   * in that order, because the API refuses to list a story with nothing
   * readable in it. An author holding a chapter back withdraws it individually
   * from the chapter list; the button here means what the dialog says it
   * means, which is "make this story readable".
   */
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
      const result = await save({ silent: true })
      if (result === null) return

      const { storyId: id } = result
      const current = await authoringApi.listMyChapters(id)
      for (const chapter of current) {
        if (chapter.publishedAt === null && chapter.content.trim().length > 0) {
          await authoringApi.publishChapter(chapter.id)
        }
      }

      await authoringApi.publishStory(id)

      setDirty(false)
      showToast({ message: `“${title}” published.` })
      navigate('/author/stories')
    } catch (cause) {
      showToast({
        tone: 'error',
        message: messageFor(cause, 'Publishing failed. Your draft is safe.'),
      })
    } finally {
      setPublishing(false)
    }
  }

  async function onUnpublish() {
    if (storyId === null) return

    setPublishing(true)
    try {
      const story = await authoringApi.unpublishStory(storyId)
      setListed(story.listedAt !== null)
      showToast({ message: 'Story returned to draft. Only you can see it now.' })
    } catch (cause) {
      showToast({
        tone: 'error',
        message: messageFor(cause, 'We could not unpublish that story.'),
      })
    } finally {
      setPublishing(false)
    }
  }

  /* Unsaved-changes guard ---------------------------------------------- */

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  )

  useEffect(() => {
    if (!dirty) return

    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault()
    }

    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  async function onSaveAndLeave() {
    if ((await save({ silent: true })) !== null) blocker.proceed?.()
  }

  const words = countWords(active.body)
  const status = listed ? (isCompleted ? 'completed' : 'ongoing') : 'draft'

  if (loaded.status === 'error') {
    return (
      <AppShell variant="author">
        <ErrorState message={loaded.error} onRetry={loaded.reload} />
      </AppShell>
    )
  }

  if (!isNew && loaded.status === 'loading') {
    return (
      <AppShell variant="author">
        <Skeleton height="28rem" radius="var(--radius-lg)" />
      </AppShell>
    )
  }

  return (
    <AppShell variant="author">
      {/* Studio header --------------------------------------------------- */}
      <header className="editor__head">
        <div className="editor__head-main">
          <p className="editor__crumb">
            {storyId === null ? 'New story' : 'Editing'} ·{' '}
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
            {saving
              ? 'Saving…'
              : dirty
                ? 'Unsaved changes'
                : savedAt
                  ? 'All changes saved'
                  : ''}
          </span>
          <Button loading={saving} onClick={() => void onSaveDraft()} startIcon={<Icon name="check" size="1em" />}>
            Save draft
          </Button>
          <Button
            onClick={() => setMode(mode === 'write' ? 'preview' : 'write')}
            startIcon={<Icon name="eye" size="1em" />}
          >
            {mode === 'write' ? 'Preview' : 'Back to writing'}
          </Button>
          {listed ? (
            <Button
              loading={publishing}
              onClick={() => void onUnpublish()}
              startIcon={<Icon name="eye" size="1em" />}
            >
              Unpublish
            </Button>
          ) : (
            <Button
              variant="primary"
              loading={publishing}
              onClick={() => setConfirmPublish(true)}
              startIcon={<Icon name="upload" size="1em" />}
            >
              Publish
            </Button>
          )}
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
                patchChapter(active.key, { title: event.target.value })
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
                  onChange={(event) => patchChapter(active.key, { body: event.target.value })}
                />
                {errors.chapterBody ? (
                  <p className="editor__error">{errors.chapterBody}</p>
                ) : null}
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
                <li key={chapter.key} className={cn(chapter.key === activeKey && 'is-active')}>
                  <button
                    type="button"
                    className="chapter-manager__pick"
                    onClick={() => setActiveKey(chapter.key)}
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
                      aria-label={
                        chapter.published
                          ? `Unpublish ${chapter.title}`
                          : `Publish ${chapter.title}`
                      }
                      title={chapter.published ? 'Unpublish' : 'Publish'}
                      loading={chapterBusy === chapter.key}
                      onClick={() => void toggleChapter(chapter)}
                      startIcon={
                        <Icon
                          name={chapter.published ? 'eye' : 'upload'}
                          size="0.9rem"
                        />
                      }
                    />
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
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Delete ${chapter.title}`}
                      title="Delete chapter"
                      disabled={chapters.length === 1}
                      onClick={() => void removeChapter(chapter)}
                      startIcon={<Icon name="trash" size="0.9rem" />}
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
              <CoverField
                story={{
                  id: storyId ?? 'new',
                  title: title || 'Untitled story',
                  coverUrl,
                  genres:
                    genres.data?.filter((genre) => genreIds.includes(genre.id)) ?? [],
                  author: { displayName: 'You' },
                }}
                onChange={onCoverChange}
                disabled={publishing}
              />

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

              {/*
                Publication state is not a field: a story is a draft until it is
                listed, and "completed" is the one part of it the author
                decides directly. The old status select offered a hiatus the
                contract cannot store.
              */}
              <Switch
                checked={isCompleted}
                onChange={(value) => {
                  setIsCompleted(value)
                  setDirty(true)
                }}
                label="The story is complete"
                description="Tells readers no more chapters are coming."
              />
            </div>
          </Card>
        </aside>
      </div>

      {/* Insert media -------------------------------------------------- */}
      <Dialog
        open={mediaOpen}
        onClose={closeMedia}
        title={`Insert ${mediaKind}`}
        description="Attach media to this chapter. Readers see it inline while reading."
        size="sm"
        footer={
          <>
            <Button onClick={closeMedia}>Cancel</Button>
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
            onChange={(kind) => {
              setMediaKind(kind)
              setMediaFile(null)
            }}
            items={MEDIA_KINDS.map((media) => ({
              value: media.kind,
              label: media.label,
              icon: <Icon name={media.icon} size="1rem" />,
            }))}
          />

          <div
            className={cn('editor__upload', dropping && 'is-dropping')}
            onDragOver={(event) => {
              event.preventDefault()
              setDropping(true)
            }}
            onDragLeave={() => setDropping(false)}
            onDrop={(event) => {
              event.preventDefault()
              setDropping(false)
              chooseMediaFile(event.dataTransfer.files[0] ?? null)
            }}
          >
            <input
              ref={mediaInputRef}
              className="visually-hidden"
              type="file"
              accept={MEDIA_ACCEPT[mediaKind]}
              onChange={(event) => {
                chooseMediaFile(event.target.files?.[0] ?? null)
                // Reset, so picking the same file twice still fires a change.
                event.target.value = ''
              }}
            />
            <Icon name="upload" size="1.5rem" />
            {mediaFile ? (
              <p className="editor__upload-file">
                <strong>{mediaFile.name}</strong>
                <span>{formatFileSize(mediaFile.size)}</span>
              </p>
            ) : (
              <p>Drag a file here, or choose one from your device</p>
            )}
            <div className="editor__upload-actions">
              <Button size="sm" onClick={() => mediaInputRef.current?.click()}>
                {mediaFile ? 'Choose a different file' : 'Choose file'}
              </Button>
              {mediaFile ? (
                <Button size="sm" variant="ghost" onClick={() => setMediaFile(null)}>
                  Remove
                </Button>
              ) : null}
            </div>
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
            The caption and placement are saved with your draft now; the file
            itself attaches once uploads are connected.
          </InlineNotice>
        </div>
      </Dialog>

      <ConfirmDialog
        open={confirmPublish}
        title={`Publish “${title || 'Untitled story'}”?`}
        message="Every chapter you have written goes live and the story becomes visible to every reader on Scribe. You can unpublish later."
        confirmLabel="Publish now"
        tone="primary"
        pending={publishing}
        onConfirm={() => void onPublish()}
        onCancel={() => setConfirmPublish(false)}
      />

      <Dialog
        open={blocker.state === 'blocked'}
        onClose={() => blocker.reset?.()}
        title="Save your changes?"
        description="This chapter has edits that are not saved yet."
        size="sm"
        dismissible={!saving}
        footer={
          <>
            <Button variant="ghost" onClick={() => blocker.proceed?.()} disabled={saving}>
              Discard changes
            </Button>
            <Button variant="primary" onClick={() => void onSaveAndLeave()} loading={saving}>
              Save and leave
            </Button>
          </>
        }
      >
        <p className="editor__cover-note">
          Anything you have written since the last save will be lost if you
          leave now.
        </p>
      </Dialog>
    </AppShell>
  )
}
