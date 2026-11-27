/**
 * Offline reading, against an in-memory store (jsdom has no IndexedDB) and the
 * fake API, so the real `api-client` and `stories-api` run on top: saving,
 * reading the copy when the network fails, keeping it current, and sending
 * what happened offline once the reader is back.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiError, fakeApi, type FakeApi } from '../test/fake-api'
import { createMemoryStorage } from '../test/memory-offline-storage'
import * as stories from '../data/stories-api'
import {
  MAX_SAVED_STORIES,
  flushPending,
  forgetSavedStories,
  getOfflineSnapshot,
  isSavedCopy,
  refreshSavedStories,
  rememberPosition,
  saveStoryOffline,
  setOfflineOwner,
  setOfflineStorage,
} from './offline'
import type { Chapter, ChapterSummary, StoryDetail } from '../types/stories'

const OWNER = 'reader-1'
const LONG_AGO = '2026-01-01T00:00:00.000Z'

const STORY: StoryDetail = {
  id: 'story-1',
  slug: 'the-lamplighter',
  title: 'The Lamplighter',
  description: null,
  coverUrl: null,
  source: 'SCRIBE',
  status: 'ongoing',
  isCompleted: false,
  kidsAppropriate: true,
  quoteCards: true,
  viewCount: 0,
  likeCount: 0,
  ratingAverage: null,
  ratingCount: 0,
  chapterCount: 3,
  wordCount: 30,
  listedAt: LONG_AGO,
  publishedAt: null,
  createdAt: LONG_AGO,
  updatedAt: LONG_AGO,
  author: { id: 'author-1', username: 'ann', displayName: 'Ann', avatarUrl: null },
  genres: [],
  nextRelease: null,
  access: 'reader',
}

function summary(number: number, overrides: Partial<ChapterSummary> = {}): ChapterSummary {
  return {
    id: `chapter-${number}`,
    storyId: STORY.id,
    number,
    title: `Chapter ${number}`,
    wordCount: 10,
    publishedAt: LONG_AGO,
    scheduledAt: null,
    updatedAt: LONG_AGO,
    ...overrides,
  }
}

/** What the server has: the story, and its chapter list as the reader sees it. */
let server: { story: StoryDetail; chapters: ChapterSummary[]; text: Record<string, string> }
let api: FakeApi
let memory: ReturnType<typeof createMemoryStorage>

function chapterBody(row: ChapterSummary): Chapter {
  return {
    ...row,
    content: server.text[row.id] ?? `The text of ${row.title}.`,
    multimedia: [],
    previousNumber: null,
    nextNumber: null,
    likeCount: 4,
    likedByMe: false,
  }
}

/** Lets fire-and-forget storage writes land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function serve() {
  api = fakeApi()
    .on('GET /stories/:slug', ({ params }) =>
      params.slug === server.story.id || params.slug === server.story.slug
        ? { story: server.story }
        : apiError(404, 'not_found', 'That story could not be found.'),
    )
    .on('GET /stories/:slug/chapters', () => ({ chapters: server.chapters }))
    .on('GET /stories/:slug/chapters/:number', ({ params }) => {
      const row = server.chapters.find((chapter) => chapter.number === Number(params.number))
      return row
        ? { chapter: chapterBody(row) }
        : apiError(404, 'not_found', 'That chapter could not be found.')
    })
    .on('POST /reading/reads', ({ body }) => ({
      recorded: (body as { chapterIds: string[] }).chapterIds.length,
    }))
    .on('PUT /reading/progress', () => ({ progress: {}, readingStreak: 1 }))
}

/** Every request fails to reach the server from here on. */
function goUnreachable() {
  vi.stubGlobal('fetch', async () => {
    throw new TypeError('Failed to fetch')
  })
}

beforeEach(async () => {
  server = {
    story: { ...STORY },
    // An author's scheduled chapter is in their list, but never saved.
    chapters: [summary(1), summary(2), summary(3, { publishedAt: null })],
    text: {},
  }
  serve()
  memory = createMemoryStorage()
  setOfflineStorage(memory)
  setOfflineOwner(OWNER)
  await settle()
})

describe('saving a story', () => {
  it('saves its published chapters without counting them as reads', async () => {
    const record = await saveStoryOffline(STORY.slug)

    expect(record.chapters.map((chapter) => chapter.number)).toEqual([1, 2])
    expect(memory.chapterRows.size).toBe(2)
    expect(record.bytes).toBeGreaterThan(0)

    const fetches = api.calls.filter((call) => call.path.startsWith('/stories'))
    expect(fetches.length).toBe(4)
    for (const call of fetches) expect(call.headers.get('X-Scribe-Offline')).toBe('1')

    expect(getOfflineSnapshot().stories.map((row) => row.storyId)).toEqual([STORY.id])
    expect(getOfflineSnapshot().saving).toEqual({})
  })

  it('refuses a draft', async () => {
    server.story = { ...STORY, status: 'draft', listedAt: null, access: 'beta' }

    await expect(saveStoryOffline(STORY.slug)).rejects.toThrow(/Only published stories/)
    expect(memory.chapterRows.size).toBe(0)
  })

  it(`keeps at most ${MAX_SAVED_STORIES} stories for one account`, async () => {
    for (let index = 0; index < MAX_SAVED_STORIES; index += 1) {
      server.story = { ...STORY, id: `story-${index + 10}`, slug: `story-${index + 10}` }
      await saveStoryOffline(server.story.slug)
    }
    server.story = { ...STORY, id: 'one-too-many', slug: 'one-too-many' }

    await expect(saveStoryOffline('one-too-many')).rejects.toThrow(/Remove one to save another/)
  })

  it('needs a signed-in reader', async () => {
    setOfflineOwner(null)

    await expect(saveStoryOffline(STORY.slug)).rejects.toThrow(/Sign in/)
  })
})

describe('reading the saved copy', () => {
  beforeEach(async () => {
    await saveStoryOffline(STORY.slug)
  })

  it('answers when the server cannot be reached, and queues the read', async () => {
    goUnreachable()

    const story = await stories.getStory(STORY.slug)
    const list = await stories.getChapters(STORY.id)
    const chapter = await stories.getChapter(STORY.id, 2)
    await settle()

    expect(story.title).toBe('The Lamplighter')
    expect(isSavedCopy(story)).toBe(true)
    expect(list.map((row) => row.number)).toEqual([1, 2])
    expect(chapter).toMatchObject({ number: 2, previousNumber: 1, nextNumber: null })
    expect(chapter.content).toBe('The text of Chapter 2.')
    expect(isSavedCopy(chapter)).toBe(true)

    expect(await memory.pending(OWNER)).toMatchObject([
      { kind: 'read', chapterId: 'chapter-2' },
    ])
  })

  it('does not try the network while the browser is offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const before = api.calls.length

    const chapter = await stories.getChapter(STORY.slug, 1)

    expect(chapter.title).toBe('Chapter 1')
    expect(api.calls.length).toBe(before)
  })

  it('serves the live chapter, unmarked, when the server answers', async () => {
    const chapter = await stories.getChapter(STORY.id, 1)

    expect(isSavedCopy(chapter)).toBe(false)
    expect(chapter.likeCount).toBe(4)
  })

  it("lets the server's own answer stand: a 404 is not a reason to show the copy", async () => {
    api.on('GET /stories/:slug/chapters/:number', () =>
      apiError(404, 'not_found', 'That chapter could not be found.'),
    )

    await expect(stories.getChapter(STORY.id, 1)).rejects.toMatchObject({ status: 404 })
  })

  it('says so for a chapter that was never saved', async () => {
    goUnreachable()

    await expect(stories.getChapter(STORY.id, 3)).rejects.toThrow(/isn't saved/)
  })

  it('will not open a copy unchecked for 30 days', async () => {
    const [record] = await memory.stories(OWNER)
    await memory.write({ ...record!, checkedAt: LONG_AGO }, [], [])
    goUnreachable()

    await expect(stories.getChapter(STORY.id, 1)).rejects.toThrow(/has not been checked for 30 days/)
  })

  it('belongs to the account that saved it', async () => {
    setOfflineOwner('someone-else')
    goUnreachable()

    await expect(stories.getStory(STORY.slug)).rejects.toMatchObject({ code: 'network_error' })
  })
})

describe('keeping a copy current', () => {
  beforeEach(async () => {
    await saveStoryOffline(STORY.slug)
    // Due for a check.
    const [record] = await memory.stories(OWNER)
    await memory.write({ ...record!, checkedAt: '2026-11-01T00:00:00.000Z' }, [], [])
  })

  it('fetches new and edited chapters, and deletes withdrawn ones', async () => {
    const edited = '2026-11-20T00:00:00.000Z'
    server.text['chapter-2'] = 'A rewritten second chapter.'
    server.chapters = [
      // Chapter 1 was unpublished; 2 renumbered to 1 and edited; 4 is new.
      summary(2, { number: 1, updatedAt: edited }),
      summary(4, { number: 2 }),
    ]
    const before = api.calls.length

    const outcome = await refreshSavedStories()

    expect(outcome.removed).toEqual([])
    const [record] = await memory.stories(OWNER)
    expect(record!.chapters.map((chapter) => [chapter.id, chapter.number])).toEqual([
      ['chapter-2', 1],
      ['chapter-4', 2],
    ])
    expect([...memory.chapterRows.keys()].sort()).toEqual([
      `${OWNER}:${STORY.id}:chapter-2`,
      `${OWNER}:${STORY.id}:chapter-4`,
    ])
    // Story, list, and the two chapters that changed.
    expect(api.calls.length - before).toBe(4)

    goUnreachable()
    const chapter = await stories.getChapter(STORY.id, 1)
    expect(chapter.content).toBe('A rewritten second chapter.')
  })

  it('leaves unchanged chapters alone', async () => {
    const before = api.calls.length

    await refreshSavedStories()

    expect(api.calls.length - before).toBe(2)
  })

  it('deletes a story that can no longer be read, and says which', async () => {
    api.on('GET /stories/:slug', () => apiError(404, 'not_found', 'That story could not be found.'))

    const outcome = await refreshSavedStories()

    expect(outcome.removed).toEqual(['The Lamplighter'])
    expect(await memory.stories(OWNER)).toEqual([])
    expect(memory.chapterRows.size).toBe(0)
  })

  it('keeps the copy when the server cannot be reached', async () => {
    goUnreachable()

    const outcome = await refreshSavedStories()

    expect(outcome.removed).toEqual([])
    expect(memory.chapterRows.size).toBe(2)
  })
})

describe('what happened offline', () => {
  beforeEach(async () => {
    await saveStoryOffline(STORY.slug)
  })

  it('sends queued reads and the latest place once online', async () => {
    goUnreachable()
    await stories.getChapter(STORY.id, 1)
    await stories.getChapter(STORY.id, 2)
    await rememberPosition(STORY.id, { id: 'chapter-1', number: 1 }, 40, { unsent: true })
    await rememberPosition(STORY.id, { id: 'chapter-2', number: 2 }, 12, { unsent: true })
    await settle()

    serve()
    await flushPending()

    const [reads] = api.callsTo('POST /reading/reads')
    expect((reads!.body as { chapterIds: string[] }).chapterIds.sort()).toEqual([
      'chapter-1',
      'chapter-2',
    ])
    expect(api.callsTo('PUT /reading/progress').map((call) => call.body)).toEqual([
      { storyId: STORY.id, chapterId: 'chapter-2', offset: 12 },
    ])
    expect(await memory.pending(OWNER)).toEqual([])

    // The place is kept on the device for the Offline shelf, too.
    const [record] = await memory.stories(OWNER)
    expect(record!.position).toMatchObject({ chapterNumber: 2, offset: 12 })
  })

  it('keeps the queue when the server still cannot be reached', async () => {
    await rememberPosition(STORY.id, { id: 'chapter-1', number: 1 }, 40, { unsent: true })
    goUnreachable()

    await flushPending()

    expect(await memory.pending(OWNER)).toHaveLength(1)
  })

  it('drops work the server refuses for good', async () => {
    await rememberPosition(STORY.id, { id: 'chapter-1', number: 1 }, 40, { unsent: true })
    api.on('PUT /reading/progress', () => apiError(404, 'not_found', 'Gone.'))

    await flushPending()

    expect(await memory.pending(OWNER)).toEqual([])
  })
})

describe('signing out', () => {
  it("deletes the account's copies and its queue, and nobody else's", async () => {
    await saveStoryOffline(STORY.slug)
    await rememberPosition(STORY.id, { id: 'chapter-1', number: 1 }, 40, { unsent: true })
    setOfflineOwner('other-reader')
    await settle()
    await saveStoryOffline(STORY.slug)
    setOfflineOwner(OWNER)
    await settle()

    await forgetSavedStories()

    expect(await memory.stories(OWNER)).toEqual([])
    expect(await memory.pending(OWNER)).toEqual([])
    expect(await memory.stories('other-reader')).toHaveLength(1)
    expect(memory.chapterRows.size).toBe(2)
    expect(getOfflineSnapshot().stories).toEqual([])
  })
})
