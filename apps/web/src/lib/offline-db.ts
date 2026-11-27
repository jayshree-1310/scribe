/**
 * Where stories saved for offline reading are kept: IndexedDB, in this
 * browser only.
 *
 * Three object stores, every row tagged with the account that saved it, so
 * two people sharing a browser never see each other's copies and signing out
 * can delete one account's rows without touching the other's:
 *
 * - `stories`: one row per saved story -- its details, the list of saved
 *   chapters, when it was saved and last checked, and the reader's place.
 * - `chapters`: one row per saved chapter, with its text.
 * - `pending`: what happened offline and still has to reach the server --
 *   chapter reads, and the reader's latest position in a story.
 *
 * `OfflineStorage` is the whole interface `lib/offline.ts` uses, so its tests
 * can run against `test/memory-offline-storage.ts` instead (jsdom has no
 * IndexedDB).
 */

import type { Chapter, ChapterSummary, StoryDetail } from '../types/stories'

/** Where the reader was in a saved story, kept on this device. */
export interface SavedPosition {
  chapterId: string
  chapterNumber: number
  /** Character offset into the chapter, as `ReadingProgress.offset`. */
  offset: number
  at: string
}

export interface SavedStory {
  /** `${owner}:${storyId}`. */
  key: string
  /** The account that saved it. */
  owner: string
  storyId: string
  slug: string
  story: StoryDetail
  /**
   * The saved chapters, in reading order: exactly the bodies in `chapters`,
   * with the number and title the chapter list last gave them.
   */
  chapters: ChapterSummary[]
  /** Bytes of each saved chapter, by id, so a partial refresh can re-total. */
  sizes: Record<string, number>
  /** The whole copy's size, as stored text. */
  bytes: number
  savedAt: string
  /** When the copy was last confirmed against the server. */
  checkedAt: string
  position: SavedPosition | null
}

export interface SavedChapter {
  /** `${owner}:${storyId}:${chapterId}`. */
  key: string
  /** The `SavedStory.key` it belongs to. */
  storyKey: string
  chapter: Chapter
}

export interface PendingWork {
  /**
   * `${owner}:read:${chapterId}` or `${owner}:progress:${storyId}`: one read
   * per chapter and one position per story, so the latest replaces the last.
   */
  key: string
  owner: string
  kind: 'read' | 'progress'
  storyId: string
  chapterId: string
  /** The position's character offset; 0 for a read. */
  offset: number
  at: string
}

export interface OfflineStorage {
  stories(owner: string): Promise<SavedStory[]>
  story(owner: string, storyId: string): Promise<SavedStory | null>
  chapter(owner: string, storyId: string, chapterId: string): Promise<SavedChapter | null>
  /** Writes the story row, and saves and deletes chapter rows, all at once. */
  write(story: SavedStory, put: Chapter[], remove: string[]): Promise<void>
  /** Deletes a story and its chapters. */
  removeStory(owner: string, storyId: string): Promise<void>
  /** Deletes everything one account saved, its pending work included. */
  removeOwner(owner: string): Promise<void>
  pending(owner: string): Promise<PendingWork[]>
  putPending(work: PendingWork): Promise<void>
  /** Deletes each row only if it is still the one given (same `at`). */
  removePending(done: PendingWork[]): Promise<void>
}

export function storyKey(owner: string, storyId: string): string {
  return `${owner}:${storyId}`
}

export function chapterKey(owner: string, storyId: string, chapterId: string): string {
  return `${owner}:${storyId}:${chapterId}`
}

/* IndexedDB ------------------------------------------------------------- */

const DB_NAME = 'scribe-offline'
const DB_VERSION = 1

let opening: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (opening) return opening

  opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      db.createObjectStore('stories', { keyPath: 'key' }).createIndex('owner', 'owner')
      db.createObjectStore('chapters', { keyPath: 'key' }).createIndex('storyKey', 'storyKey')
      db.createObjectStore('pending', { keyPath: 'key' }).createIndex('owner', 'owner')
    }
    request.onsuccess = () => {
      const db = request.result
      // A newer version opened in another tab asks this one to let go.
      db.onversionchange = () => {
        db.close()
        opening = null
      }
      resolve(db)
    }
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('Offline storage is busy in another tab.'))
  }).catch((error: unknown) => {
    // Private windows and blocked site data: let the next call try again.
    opening = null
    throw error
  })

  return opening
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('Offline storage write was abandoned.'))
  })
}

/** Deletes every row an index maps `value` to, inside the caller's transaction. */
function deleteBy(store: IDBObjectStore, index: string, value: IDBValidKey): void {
  const keys = store.index(index).getAllKeys(value)
  keys.onsuccess = () => {
    for (const key of keys.result) store.delete(key)
  }
}

export const indexedDbStorage: OfflineStorage = {
  async stories(owner) {
    const db = await open()
    return result<SavedStory[]>(
      db.transaction('stories').objectStore('stories').index('owner').getAll(owner),
    )
  },

  async story(owner, storyId) {
    const db = await open()
    const row = await result<SavedStory | undefined>(
      db.transaction('stories').objectStore('stories').get(storyKey(owner, storyId)),
    )
    return row ?? null
  },

  async chapter(owner, storyId, chapterId) {
    const db = await open()
    const row = await result<SavedChapter | undefined>(
      db
        .transaction('chapters')
        .objectStore('chapters')
        .get(chapterKey(owner, storyId, chapterId)),
    )
    return row ?? null
  },

  async write(story, put, remove) {
    const db = await open()
    const tx = db.transaction(['stories', 'chapters'], 'readwrite')
    tx.objectStore('stories').put(story)
    const chapters = tx.objectStore('chapters')
    for (const chapter of put) {
      const row: SavedChapter = {
        key: chapterKey(story.owner, story.storyId, chapter.id),
        storyKey: story.key,
        chapter,
      }
      chapters.put(row)
    }
    for (const id of remove) chapters.delete(chapterKey(story.owner, story.storyId, id))
    return done(tx)
  },

  async removeStory(owner, storyId) {
    const db = await open()
    const tx = db.transaction(['stories', 'chapters'], 'readwrite')
    const key = storyKey(owner, storyId)
    tx.objectStore('stories').delete(key)
    deleteBy(tx.objectStore('chapters'), 'storyKey', key)
    return done(tx)
  },

  async removeOwner(owner) {
    const db = await open()
    const tx = db.transaction(['stories', 'chapters', 'pending'], 'readwrite')
    const stories = tx.objectStore('stories')
    const chapters = tx.objectStore('chapters')
    const keys = stories.index('owner').getAllKeys(owner)
    keys.onsuccess = () => {
      for (const key of keys.result) {
        stories.delete(key)
        deleteBy(chapters, 'storyKey', key)
      }
    }
    deleteBy(tx.objectStore('pending'), 'owner', owner)
    return done(tx)
  },

  async pending(owner) {
    const db = await open()
    return result<PendingWork[]>(
      db.transaction('pending').objectStore('pending').index('owner').getAll(owner),
    )
  },

  async putPending(work) {
    const db = await open()
    const tx = db.transaction('pending', 'readwrite')
    tx.objectStore('pending').put(work)
    return done(tx)
  },

  async removePending(finished) {
    const db = await open()
    const tx = db.transaction('pending', 'readwrite')
    const store = tx.objectStore('pending')
    for (const work of finished) {
      const current = store.get(work.key)
      current.onsuccess = () => {
        const row = current.result as PendingWork | undefined
        // Replaced while it was being sent: the newer one still has to go.
        if (row && row.at === work.at) store.delete(work.key)
      }
    }
    return done(tx)
  },
}

/** Whether this browser can keep stories at all. */
export function offlineStorageSupported(): boolean {
  return typeof indexedDB !== 'undefined'
}
