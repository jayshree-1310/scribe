/**
 * Stories saved for offline reading.
 *
 * A reader saves a story from its page or the reader, and Scribe keeps the
 * story's details and the text of every published chapter in this browser
 * (`lib/offline-db.ts`). It is not a download: the copy is only readable in
 * Scribe, in the browser that saved it, by the account that saved it.
 *
 * The rules, and why:
 *
 * - **Signed-in readers only.** Each copy belongs to an account, and signing
 *   out deletes that account's copies, which is what keeps a shared computer
 *   from showing the last person's books to the next.
 * - **Published chapters of listed stories only.** What anybody can read, and
 *   nothing more: a draft, a scheduled chapter or a beta reader's preview is
 *   not the reader's to carry away.
 * - **Text only.** Chapter images, audio and video are not saved; offline
 *   they fail to load as any picture does, and the reader says so.
 * - **At most `MAX_SAVED_STORIES` per account on a device.**
 * - **The author stays in control.** Each copy is checked against the server
 *   when the reader is online (`refreshSavedStories`): new and edited chapters
 *   are fetched, and a story or chapter the author unpublished, or a moderator
 *   took down, is deleted from the copy. A copy that has gone unchecked for
 *   `COPY_LIFETIME_DAYS` will not open until it has been checked again, so a
 *   take-down reaches even a reader who never reconnects. This is a rule the
 *   app honours, not copy protection: the text sits in the reader's browser.
 * - **Saving is not reading.** The fetches carry the offline header
 *   (`data/offline-api.ts`); a chapter's read is queued when its saved copy
 *   is opened and sent once the reader is online (`flushPending`), along with
 *   the reader's latest place in each story.
 *
 * Module state rather than context, like `lib/tour-preview.ts`, because the
 * data layer is not React: `data/stories-api.ts` falls back to the copy here
 * whenever a request cannot reach the server. `AuthProvider` says whose copies
 * these are (`setOfflineOwner`); components read `useOffline` below.
 */

import { useSyncExternalStore } from 'react'
import { ApiError } from './api-client'
import { isOnline } from './network-status'
import { tourPreviewHeaders } from './tour-preview'
import {
  indexedDbStorage,
  offlineStorageSupported,
  storyKey,
  type OfflineStorage,
  type PendingWork,
  type SavedStory,
} from './offline-db'
import * as offlineApi from '../data/offline-api'
import { saveProgress } from '../data/reading-api'
import type {
  Chapter,
  ChapterSummary,
  ReadingProgress,
  StoryDetail,
} from '../types/stories'

export type { SavedStory } from './offline-db'

/** Stories one account can keep on one device. */
export const MAX_SAVED_STORIES = 20

/** How long a copy opens without being checked against the server. */
export const COPY_LIFETIME_DAYS = 30
const COPY_LIFETIME_MS = COPY_LIFETIME_DAYS * 24 * 60 * 60 * 1000

/** On an ordinary page load, a copy checked this recently is left alone. */
const RECHECK_AFTER_MS = 60 * 60 * 1000

/** Coming back online checks sooner, but not on every flicker of the signal. */
const RECHECK_ON_RECONNECT_MS = 5 * 60 * 1000

/** Chapters fetched at once while saving. */
const SAVE_CONCURRENCY = 4

/* State ----------------------------------------------------------------- */

export interface SaveProgress {
  done: number
  total: number
}

export interface OfflineSnapshot {
  /** Whether this browser can save stories at all. */
  supported: boolean
  /** The signed-in account, whose copies these are. */
  owner: string | null
  /** False until the owner's copies have been read from the device. */
  ready: boolean
  /** Most recently saved first. */
  stories: SavedStory[]
  /** Saves in progress, by story id. */
  saving: Record<string, SaveProgress>
  /** Whether the browser promised to keep the copies; null when unknown. */
  persisted: boolean | null
}

let storage: OfflineStorage = indexedDbStorage

let snapshot: OfflineSnapshot = {
  supported: offlineStorageSupported(),
  owner: null,
  ready: false,
  stories: [],
  saving: {},
  persisted: null,
}

const listeners = new Set<() => void>()

function publish(next: Partial<OfflineSnapshot>): void {
  snapshot = { ...snapshot, ...next }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getOfflineSnapshot(): OfflineSnapshot {
  return snapshot
}

/** The reader's saved stories, and any save in progress. */
export function useOffline(): OfflineSnapshot {
  return useSyncExternalStore(subscribe, getOfflineSnapshot, getOfflineSnapshot)
}

/** For tests: another storage, and a clean slate. */
export function setOfflineStorage(next: OfflineStorage, supported = true): void {
  storage = next
  snapshot = {
    supported,
    owner: null,
    ready: false,
    stories: [],
    saving: {},
    persisted: null,
  }
}

/** Re-reads the owner's stories into the snapshot. */
async function reload(): Promise<void> {
  const owner = snapshot.owner
  if (!owner || !snapshot.supported) {
    publish({ stories: [], ready: true })
    return
  }
  let stories: SavedStory[] = []
  try {
    stories = await storage.stories(owner)
  } catch {
    // Storage blocked: nothing saved is the honest answer.
  }
  // Signed out, or somebody else signed in, while that was read.
  if (snapshot.owner !== owner) return
  stories.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  publish({ stories, ready: true })
}

/**
 * Whose copies to read and write. Called by `AuthProvider` before any page
 * asks for data (a layout effect), so a reader opening a saved chapter with no
 * connection gets it on the first try.
 */
export function setOfflineOwner(owner: string | null): void {
  if (snapshot.owner === owner) return
  publish({ owner, ready: owner === null, stories: [], saving: {} })
  void reload()
  void checkPersistence()
}

/**
 * Signing out: deletes every story the signed-in account saved here, and
 * whatever it had queued for the server.
 */
export async function forgetSavedStories(): Promise<void> {
  const owner = snapshot.owner
  if (!owner || !snapshot.supported) return
  try {
    await storage.removeOwner(owner)
  } catch {
    // Nothing more can be done from here; the rows stay keyed to the account.
  }
  await reload()
}

async function checkPersistence(): Promise<void> {
  try {
    const persisted = await navigator.storage?.persisted?.()
    if (typeof persisted === 'boolean') publish({ persisted })
  } catch {
    // Unsupported: leave it unknown.
  }
}

/**
 * Asks the browser to keep the copies when the device runs low on space.
 * Chrome decides by itself (often yes for an installed or much-used site);
 * Firefox may ask the reader.
 */
async function requestPersistence(): Promise<void> {
  if (snapshot.persisted) return
  try {
    const persisted = await navigator.storage?.persist?.()
    if (typeof persisted === 'boolean') publish({ persisted })
  } catch {
    // Unsupported: the copies are kept as long as the browser allows.
  }
}

/* Saving ---------------------------------------------------------------- */

/** An offline problem with a message to show as it is. */
export class OfflineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OfflineError'
  }
}

/** Only what anybody can read may be saved: a listed Scribe story. */
export function canSaveOffline(story: Pick<StoryDetail, 'source' | 'status' | 'listedAt'>): boolean {
  return story.source === 'SCRIBE' && story.status !== 'draft' && story.listedAt !== null
}

function isPublished(chapter: ChapterSummary): boolean {
  return chapter.publishedAt !== null
}

/** A summary of a fetched chapter, so the list matches the saved body. */
function summaryOf(chapter: Chapter): ChapterSummary {
  return {
    id: chapter.id,
    storyId: chapter.storyId,
    number: chapter.number,
    title: chapter.title,
    wordCount: chapter.wordCount,
    publishedAt: chapter.publishedAt,
    scheduledAt: chapter.scheduledAt,
    updatedAt: chapter.updatedAt,
  }
}

function sizeOf(value: unknown): number {
  return new Blob([JSON.stringify(value)]).size
}

function total(story: StoryDetail, sizes: Record<string, number>): number {
  return sizeOf(story) + Object.values(sizes).reduce((sum, size) => sum + size, 0)
}

function requireOwner(): string {
  if (!snapshot.supported) {
    throw new OfflineError('This browser cannot keep stories for offline reading.')
  }
  const owner = snapshot.owner
  if (!owner) throw new OfflineError('Sign in to save stories for offline reading.')
  return owner
}

function setSaving(storyId: string, progress: SaveProgress | null): void {
  const saving = { ...snapshot.saving }
  if (progress) saving[storyId] = progress
  else delete saving[storyId]
  publish({ saving })
}

/** Runs `work` over `items`, `limit` at a time, keeping their order. */
async function inBatches<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []
  for (let index = 0; index < items.length; index += limit) {
    results.push(...(await Promise.all(items.slice(index, index + limit).map(work))))
  }
  return results
}

/**
 * Saves a story for offline reading: its details and every published
 * chapter. Saving one already saved fetches it again in full.
 */
export async function saveStoryOffline(slugOrId: string): Promise<SavedStory> {
  const owner = requireOwner()
  if (!isOnline()) throw new OfflineError("You're offline. Connect to save this story.")

  const story = await offlineApi.fetchStoryForCopy(slugOrId)
  if (!canSaveOffline(story)) {
    throw new OfflineError('Only published stories can be saved for offline reading.')
  }

  const existing = await storage.stories(owner)
  const previous = existing.find((row) => row.storyId === story.id) ?? null
  if (!previous && existing.length >= MAX_SAVED_STORIES) {
    throw new OfflineError(
      `You can keep ${MAX_SAVED_STORIES} stories offline. Remove one to save another.`,
    )
  }

  const listed = (await offlineApi.fetchChaptersForCopy(story.id)).filter(isPublished)
  if (listed.length === 0) {
    throw new OfflineError('This story has no published chapters to save yet.')
  }

  let fetched = 0
  setSaving(story.id, { done: 0, total: listed.length })
  try {
    const chapters = await inBatches(listed, SAVE_CONCURRENCY, async (summary) => {
      const chapter = await offlineApi.fetchChapterForCopy(story.id, summary.number)
      fetched += 1
      setSaving(story.id, { done: fetched, total: listed.length })
      return chapter
    })

    const sizes = Object.fromEntries(chapters.map((chapter) => [chapter.id, sizeOf(chapter)]))
    const now = new Date().toISOString()
    const record: SavedStory = {
      key: storyKey(owner, story.id),
      owner,
      storyId: story.id,
      slug: story.slug,
      story,
      chapters: chapters.map(summaryOf),
      sizes,
      bytes: total(story, sizes),
      savedAt: previous?.savedAt ?? now,
      checkedAt: now,
      position: previous?.position ?? null,
    }
    const kept = new Set(chapters.map((chapter) => chapter.id))
    const dropped = (previous?.chapters ?? [])
      .map((chapter) => chapter.id)
      .filter((id) => !kept.has(id))

    await storage.write(record, chapters, dropped)
    void requestPersistence()
    await reload()
    return record
  } finally {
    setSaving(story.id, null)
  }
}

export async function removeSavedStory(storyId: string): Promise<void> {
  const owner = requireOwner()
  await storage.removeStory(owner, storyId)
  await reload()
}

/** Whole days since a copy was last confirmed against the server. */
export function daysSinceChecked(row: Pick<SavedStory, 'checkedAt'>): number {
  return Math.floor((Date.now() - Date.parse(row.checkedAt)) / (24 * 60 * 60 * 1000))
}

/* Reading the copy ------------------------------------------------------ */

/**
 * Objects served from a saved copy rather than the network, so the reader can
 * tell (and hide what needs the server). A WeakSet rather than a field, because
 * `types/stories.ts` mirrors the API exactly.
 */
const fromCopy = new WeakSet<object>()

export function isSavedCopy(value: object | null | undefined): boolean {
  return value !== null && value !== undefined && fromCopy.has(value)
}

function marked<T extends object>(value: T): T {
  fromCopy.add(value)
  return value
}

/** The current reader's saved copy of `slugOrId`, if there is one. */
async function findSaved(slugOrId: string): Promise<SavedStory | null> {
  const owner = snapshot.owner
  if (!owner || !snapshot.supported) return null
  const stories = await storage.stories(owner)
  const found = stories.find((row) => row.storyId === slugOrId || row.slug === slugOrId) ?? null
  if (found && Date.now() - Date.parse(found.checkedAt) > COPY_LIFETIME_MS) {
    throw new ApiError(
      `Your offline copy of “${found.story.title}” has not been checked for ${COPY_LIFETIME_DAYS} days. Connect to the internet to keep reading it.`,
      { code: 'offline_copy_expired' },
    )
  }
  return found
}

export async function savedStory(slugOrId: string): Promise<StoryDetail | null> {
  const found = await findSaved(slugOrId)
  return found ? marked({ ...found.story }) : null
}

export async function savedChapterList(slugOrId: string): Promise<ChapterSummary[] | null> {
  const found = await findSaved(slugOrId)
  return found ? marked(found.chapters.map((chapter) => ({ ...chapter }))) : null
}

/**
 * One saved chapter, as the API would serve it. Its number, title and
 * neighbours come from the saved list, which a check may have renumbered
 * without the text changing. Opening it queues the read.
 */
export async function savedChapter(slugOrId: string, number: number): Promise<Chapter | null> {
  const found = await findSaved(slugOrId)
  if (!found) return null

  const index = found.chapters.findIndex((chapter) => chapter.number === number)
  const summary = found.chapters[index]
  if (!summary) {
    throw new ApiError("That chapter isn't saved for offline reading.", {
      code: 'offline_chapter_missing',
    })
  }

  const row = await storage.chapter(found.owner, found.storyId, summary.id)
  if (!row) return null

  const chapter = marked({
    ...row.chapter,
    number: summary.number,
    title: summary.title,
    previousNumber: found.chapters[index - 1]?.number ?? null,
    nextNumber: found.chapters[index + 1]?.number ?? null,
  })

  // The tour's visits are not reading, offline or not.
  if (Object.keys(tourPreviewHeaders()).length === 0) {
    void queue({
      key: `${found.owner}:read:${chapter.id}`,
      owner: found.owner,
      kind: 'read',
      storyId: found.storyId,
      chapterId: chapter.id,
      offset: 0,
      at: new Date().toISOString(),
    })
  }

  return chapter
}

/**
 * A read that falls back to the saved copy.
 *
 * With the browser offline, the copy is read first and the network not tried.
 * Otherwise the network is, and the copy answers only when the request never
 * reached the server; a 404 or a 500 is the server's answer and stands.
 */
export async function withSavedCopy<T>(
  live: () => Promise<T>,
  saved: () => Promise<T | null>,
): Promise<T> {
  if (!isOnline()) {
    const copy = await readCopy(saved)
    if (copy !== null) return copy
    return live()
  }

  try {
    return await live()
  } catch (cause) {
    if (!(cause instanceof ApiError) || !cause.isOffline) throw cause
    const copy = await readCopy(saved)
    if (copy === null) throw cause
    return copy
  }
}

/** The copy, or null when there is none or storage cannot be read. */
async function readCopy<T>(saved: () => Promise<T | null>): Promise<T | null> {
  try {
    return await saved()
  } catch (cause) {
    // An expired copy or a chapter that was never saved says so; a storage
    // failure is no copy at all.
    if (cause instanceof ApiError) throw cause
    return null
  }
}

/* The reader's place, and what is waiting for the server ---------------- */

async function queue(work: PendingWork): Promise<void> {
  try {
    await storage.putPending(work)
  } catch {
    // Lost, as a position that cannot be saved online is lost.
  }
}

/**
 * Keeps the reader's place in a saved story on this device, so the Offline
 * shelf can resume there and an offline visit restores it. `unsent` also
 * queues it for the server, because the save there just failed.
 */
export async function rememberPosition(
  storyId: string,
  chapter: { id: string; number: number },
  offset: number,
  { unsent }: { unsent: boolean },
): Promise<void> {
  const owner = snapshot.owner
  if (!owner || !snapshot.supported) return
  // Sent, and not a saved story: nothing to keep here.
  if (!unsent && !snapshot.stories.some((row) => row.storyId === storyId)) return
  const at = new Date().toISOString()

  if (unsent) {
    await queue({
      key: `${owner}:progress:${storyId}`,
      owner,
      kind: 'progress',
      storyId,
      chapterId: chapter.id,
      offset,
      at,
    })
  }

  try {
    const record = await storage.story(owner, storyId)
    if (!record) return
    record.position = { chapterId: chapter.id, chapterNumber: chapter.number, offset, at }
    await storage.write(record, [], [])
    const stories = snapshot.stories.map((row) => (row.storyId === storyId ? record : row))
    publish({ stories })
  } catch {
    // The shelf resumes from the last place it did keep.
  }
}

/** The place kept on this device, shaped like the server's answer. */
export async function savedProgress(storyId: string): Promise<ReadingProgress | null> {
  const owner = snapshot.owner
  if (!owner || !snapshot.supported) return null
  try {
    const record = await storage.story(owner, storyId)
    const position = record?.position
    if (!position) return null
    return {
      storyId,
      chapterId: position.chapterId,
      chapterNumber: position.chapterNumber,
      offset: position.offset,
      percentComplete: 0,
      lastReadAt: position.at,
    }
  } catch {
    return null
  }
}

let flushing = false

/**
 * Sends what happened offline: chapter reads in batches, then the latest
 * place in each story. Stops at the first request that cannot reach the
 * server and keeps the rest for next time. Work the server refuses outright
 * (a chapter deleted since) is dropped, since it never will be accepted.
 */
export async function flushPending(): Promise<void> {
  const owner = snapshot.owner
  if (!owner || !snapshot.supported || flushing || !isOnline()) return
  flushing = true

  try {
    const work = await storage.pending(owner)
    const reads = work.filter((item) => item.kind === 'read')
    const positions = work.filter((item) => item.kind === 'progress')

    for (let index = 0; index < reads.length; index += offlineApi.READS_PER_REQUEST) {
      const batch = reads.slice(index, index + offlineApi.READS_PER_REQUEST)
      if (!(await settle(batch, () => offlineApi.recordReads(batch.map((item) => item.chapterId))))) {
        return
      }
    }

    for (const item of positions) {
      const sent = await settle([item], () =>
        saveProgress({ storyId: item.storyId, chapterId: item.chapterId, offset: item.offset }),
      )
      if (!sent) return
    }
  } catch {
    // Storage could not be read; next time.
  } finally {
    flushing = false
  }
}

/** Sends one piece of work; false means stop flushing and keep it. */
async function settle(items: PendingWork[], send: () => Promise<unknown>): Promise<boolean> {
  try {
    await send()
  } catch (cause) {
    const refused =
      cause instanceof ApiError &&
      cause.status >= 400 &&
      cause.status < 500 &&
      cause.status !== 401 &&
      cause.status !== 429
    if (!refused) return false
  }
  await storage.removePending(items)
  return true
}

/* Keeping copies current ------------------------------------------------ */

let refreshing = false

export interface RefreshOutcome {
  /** Titles of stories deleted because they can no longer be read. */
  removed: string[]
}

/**
 * Checks the reader's saved stories against the server: fetches new and
 * edited chapters, deletes what was unpublished or taken down, and marks each
 * copy checked. `reconnected` is the browser coming back online, which checks
 * anything not checked in the last few minutes rather than the last hour.
 *
 * One story at a time, so a reader with twenty saved never sends a burst; and
 * it stops at the first request that cannot reach the server.
 */
export async function refreshSavedStories(
  { reconnected = false }: { reconnected?: boolean } = {},
): Promise<RefreshOutcome> {
  const outcome: RefreshOutcome = { removed: [] }
  const owner = snapshot.owner
  if (!owner || !snapshot.supported || refreshing || !isOnline()) return outcome
  refreshing = true

  try {
    const stories = await storage.stories(owner)
    const due = reconnected ? RECHECK_ON_RECONNECT_MS : RECHECK_AFTER_MS

    for (const record of stories) {
      if (Date.now() - Date.parse(record.checkedAt) < due) continue
      const result = await refreshOne(record)
      if (result === 'unreachable') break
      if (result === 'removed') outcome.removed.push(record.story.title)
    }
  } catch {
    // Storage could not be read; next time.
  } finally {
    refreshing = false
    if (snapshot.owner === owner) await reload()
  }

  return outcome
}

type Checked = 'kept' | 'removed' | 'unreachable' | 'failed'

/** How a failed request bears on the copy. */
function judge(cause: unknown): 'gone' | 'unreachable' | 'failed' {
  if (cause instanceof ApiError) {
    if (cause.isOffline) return 'unreachable'
    // Unpublished, taken down, or no longer visible to this reader.
    if (cause.status === 404) return 'gone'
  }
  return 'failed'
}

async function refreshOne(record: SavedStory): Promise<Checked> {
  const { owner, storyId } = record

  let story: StoryDetail
  let listed: ChapterSummary[]
  try {
    story = await offlineApi.fetchStoryForCopy(storyId)
    listed = canSaveOffline(story)
      ? (await offlineApi.fetchChaptersForCopy(storyId)).filter(isPublished)
      : []
  } catch (cause) {
    const verdict = judge(cause)
    if (verdict !== 'gone') return verdict
    await storage.removeStory(owner, storyId)
    return 'removed'
  }

  if (listed.length === 0) {
    await storage.removeStory(owner, storyId)
    return 'removed'
  }

  const saved = new Map(record.chapters.map((chapter) => [chapter.id, chapter]))
  const sizes = { ...record.sizes }
  const fetched: Chapter[] = []
  const chapters: ChapterSummary[] = []

  for (const summary of listed) {
    const have = saved.get(summary.id)
    if (have && have.updatedAt === summary.updatedAt) {
      // Unchanged text; the number may have moved if one before it went.
      chapters.push({ ...have, number: summary.number, title: summary.title })
      continue
    }
    try {
      const chapter = await offlineApi.fetchChapterForCopy(storyId, summary.number)
      // Renumbered between the list and this request: next check.
      if (chapter.id !== summary.id) {
        if (have) chapters.push(have)
        continue
      }
      fetched.push(chapter)
      sizes[chapter.id] = sizeOf(chapter)
      chapters.push(summaryOf(chapter))
    } catch (cause) {
      const verdict = judge(cause)
      if (verdict === 'unreachable') return verdict
      // Gone between the list and this request; anything else, keep the old.
      if (verdict === 'failed' && have) chapters.push(have)
    }
  }

  const kept = new Set(chapters.map((chapter) => chapter.id))
  const dropped = record.chapters.map((chapter) => chapter.id).filter((id) => !kept.has(id))
  for (const id of dropped) delete sizes[id]

  await storage.write(
    {
      ...record,
      slug: story.slug,
      story,
      chapters,
      sizes,
      bytes: total(story, sizes),
      checkedAt: new Date().toISOString(),
    },
    fetched,
    dropped,
  )
  return 'kept'
}
