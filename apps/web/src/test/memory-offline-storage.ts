/**
 * `OfflineStorage` over plain maps, for tests: jsdom has no IndexedDB.
 */

import {
  chapterKey,
  storyKey,
  type OfflineStorage,
  type PendingWork,
  type SavedChapter,
  type SavedStory,
} from '../lib/offline-db'

/**
 * The same interface over plain maps. Rows are cloned on the way in and out,
 * as IndexedDB's structured clone does, so a test cannot pass by mutating a
 * row it was handed.
 */
export function createMemoryStorage(): OfflineStorage & {
  chapterRows: Map<string, SavedChapter>
} {
  const stories = new Map<string, SavedStory>()
  const chapterRows = new Map<string, SavedChapter>()
  const pending = new Map<string, PendingWork>()
  const clone = <T>(value: T): T => structuredClone(value)

  return {
    chapterRows,
    async stories(owner) {
      return [...stories.values()].filter((row) => row.owner === owner).map(clone)
    },
    async story(owner, storyId) {
      const row = stories.get(storyKey(owner, storyId))
      return row ? clone(row) : null
    },
    async chapter(owner, storyId, chapterId) {
      const row = chapterRows.get(chapterKey(owner, storyId, chapterId))
      return row ? clone(row) : null
    },
    async write(story, put, remove) {
      stories.set(story.key, clone(story))
      for (const chapter of put) {
        const key = chapterKey(story.owner, story.storyId, chapter.id)
        chapterRows.set(key, { key, storyKey: story.key, chapter: clone(chapter) })
      }
      for (const id of remove) chapterRows.delete(chapterKey(story.owner, story.storyId, id))
    },
    async removeStory(owner, storyId) {
      const key = storyKey(owner, storyId)
      stories.delete(key)
      for (const [rowKey, row] of chapterRows) if (row.storyKey === key) chapterRows.delete(rowKey)
    },
    async removeOwner(owner) {
      for (const [key, row] of stories) {
        if (row.owner !== owner) continue
        stories.delete(key)
        for (const [rowKey, chapter] of chapterRows) {
          if (chapter.storyKey === key) chapterRows.delete(rowKey)
        }
      }
      for (const [key, row] of pending) if (row.owner === owner) pending.delete(key)
    },
    async pending(owner) {
      return [...pending.values()].filter((row) => row.owner === owner).map(clone)
    },
    async putPending(work) {
      pending.set(work.key, clone(work))
    },
    async removePending(finished) {
      for (const work of finished) {
        if (pending.get(work.key)?.at === work.at) pending.delete(work.key)
      }
    },
  }
}
