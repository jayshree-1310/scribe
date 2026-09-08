/**
 * Data access for the UI.
 *
 * Every function is async and adds a little latency so loading and error
 * states are exercised for real during development. When the Scribe API is
 * ready, these bodies become fetch calls; no component needs to change.
 */

import * as db from './mock-db'
import type {
  Badge,
  BookClub,
  BroadcastChannel,
  Chapter,
  ChallengeEntry,
  ChannelPost,
  ClubDiscussion,
  Comment,
  DiscoverFilters,
  Genre,
  LibraryShelf,
  Rating,
  ReadingEntry,
  Story,
  StoryWithMeta,
  User,
  UserBadge,
  WritingChallenge,
} from '../types/domain'

/** Simulated round-trip, kept short enough not to slow development down. */
const LATENCY_MS = 260

function delay<T>(value: T, ms = LATENCY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} could not be found.`)
    this.name = 'NotFoundError'
  }
}

/* Joins ---------------------------------------------------------------- */

function withMeta(story: Story): StoryWithMeta {
  const author = db.userById.get(story.authorId)
  if (!author) throw new NotFoundError('The author of this story')

  return {
    ...story,
    author,
    genres: story.genreIds
      .map((id) => db.genreById.get(id))
      .filter((genre): genre is Genre => genre !== undefined),
  }
}

function chapterSummary(chapter: Chapter): Pick<Chapter, 'id' | 'number' | 'title'> {
  return { id: chapter.id, number: chapter.number, title: chapter.title }
}

function toReadingEntry(historyId: string): ReadingEntry | null {
  const history = db.readingHistory.find((entry) => entry.id === historyId)
  if (!history) return null

  const story = db.storyById.get(history.storyId)
  const chapters = db.chaptersByStory.get(history.storyId) ?? []
  const chapter = chapters.find((item) => item.id === history.chapterId) ?? chapters[0]
  if (!story || !chapter) return null

  return { history, story: withMeta(story), chapter: chapterSummary(chapter) }
}

/* Reference data ------------------------------------------------------- */

export function getGenres(): Promise<Genre[]> {
  return delay(db.genres, 120)
}

export function getAuthors(): Promise<User[]> {
  return delay(db.authors, 140)
}

/* Stories -------------------------------------------------------------- */

function score(story: Story, sort: DiscoverFilters['sort']): number {
  switch (sort) {
    case 'top-rated':
      return story.ratingAverage * 1000 + story.ratingCount / 1000
    case 'recent':
      return new Date(story.publishedAt ?? story.updatedAt).getTime() / 1e7
    case 'popular-week':
      return story.likeCount + story.commentCount * 4
    case 'recommended':
      return story.ratingAverage * 400 + story.likeCount / 100
    case 'trending':
    default:
      return story.viewCount / 1000 + story.likeCount / 100
  }
}

function matches(story: StoryWithMeta, filters: DiscoverFilters): boolean {
  if (filters.genreId && !story.genreIds.includes(filters.genreId)) return false
  if (filters.status !== 'all' && story.status !== filters.status) return false
  if (filters.kidsOnly && !story.kidsAppropriate) return false

  const term = filters.search.trim().toLowerCase()
  if (!term) return true

  return (
    story.title.toLowerCase().includes(term) ||
    story.synopsis.toLowerCase().includes(term) ||
    story.author.displayName.toLowerCase().includes(term) ||
    story.genres.some((genre) => genre.name.toLowerCase().includes(term))
  )
}

export function discoverStories(filters: DiscoverFilters): Promise<StoryWithMeta[]> {
  const results = db.stories
    .filter((story) => story.status !== 'draft')
    .map(withMeta)
    .filter((story) => matches(story, filters))
    .sort((a, b) => score(b, filters.sort) - score(a, filters.sort))

  return delay(results)
}

export function getTrendingStories(limit = 8): Promise<StoryWithMeta[]> {
  const results = db.stories
    .filter((story) => story.status !== 'draft')
    .map(withMeta)
    .sort((a, b) => score(b, 'trending') - score(a, 'trending'))
    .slice(0, limit)

  return delay(results)
}

export function getRecommendedStories(
  genreIds: string[],
  limit = 8,
): Promise<StoryWithMeta[]> {
  const preferred = db.stories.filter(
    (story) =>
      story.status !== 'draft' &&
      (genreIds.length === 0 || story.genreIds.some((id) => genreIds.includes(id))),
  )
  const pool = preferred.length >= limit ? preferred : db.stories

  const results = pool
    .map(withMeta)
    .sort((a, b) => score(b, 'recommended') - score(a, 'recommended'))
    .slice(0, limit)

  return delay(results)
}

export function getStory(slug: string): Promise<StoryWithMeta> {
  const story = db.stories.find((item) => item.slug === slug || item.id === slug)
  if (!story) return Promise.reject(new NotFoundError('That story'))
  return delay(withMeta(story))
}

export function getChapters(storyId: string): Promise<Chapter[]> {
  return delay(db.chaptersByStory.get(storyId) ?? [], 180)
}

export function getChapter(storyId: string, chapterNumber: number): Promise<Chapter> {
  const chapter = (db.chaptersByStory.get(storyId) ?? []).find(
    (item) => item.number === chapterNumber,
  )
  if (!chapter) return Promise.reject(new NotFoundError('That chapter'))
  return delay(chapter, 200)
}

export function getSimilarStories(story: StoryWithMeta, limit = 6): Promise<StoryWithMeta[]> {
  const results = db.stories
    .filter(
      (item) =>
        item.id !== story.id &&
        item.status !== 'draft' &&
        item.genreIds.some((id) => story.genreIds.includes(id)),
    )
    .map(withMeta)
    .sort((a, b) => b.ratingAverage - a.ratingAverage)
    .slice(0, limit)

  return delay(results, 220)
}

export function getAuthorStories(authorId: string): Promise<StoryWithMeta[]> {
  const results = db.stories
    .filter((story) => story.authorId === authorId)
    .map(withMeta)
    .sort((a, b) => b.viewCount - a.viewCount)

  return delay(results, 200)
}

/* Engagement ----------------------------------------------------------- */

export interface CommentWithUser extends Comment {
  user: User
}

export function getComments(storyId: string): Promise<CommentWithUser[]> {
  const results = db.comments
    .filter((comment) => comment.storyId === storyId)
    .map((comment) => ({
      ...comment,
      user: db.userById.get(comment.userId) ?? db.currentUser,
    }))
    .sort((a, b) => b.likeCount - a.likeCount)

  return delay(results, 240)
}

export function addComment(storyId: string, body: string): Promise<CommentWithUser> {
  const trimmed = body.trim()
  if (trimmed.length === 0) {
    return Promise.reject(new Error('Write something before posting.'))
  }

  const comment: CommentWithUser = {
    id: `local-${Date.now()}`,
    storyId,
    chapterId: null,
    userId: db.currentUser.id,
    body: trimmed,
    createdAt: new Date().toISOString(),
    likeCount: 0,
    replyCount: 0,
    user: db.currentUser,
  }

  return delay(comment, 320)
}

export interface RatingWithUser extends Rating {
  user: User
}

export function getRatings(storyId: string): Promise<RatingWithUser[]> {
  const results = db.ratings
    .filter((rating) => rating.storyId === storyId)
    .map((rating) => ({
      ...rating,
      user: db.userById.get(rating.userId) ?? db.currentUser,
    }))

  return delay(results, 200)
}

/** Distribution of 1–5 scores, used by the ratings breakdown bars. */
export function getRatingBreakdown(story: Story): Record<number, number> {
  const weights: Record<number, number> = { 5: 0.52, 4: 0.29, 3: 0.12, 2: 0.05, 1: 0.02 }
  const shifted = story.ratingAverage - 4.2

  return Object.fromEntries(
    Object.entries(weights).map(([score_, weight]) => {
      const numeric = Number(score_)
      const adjusted = weight * (1 + shifted * (numeric >= 4 ? 0.5 : -0.5))
      return [numeric, Math.max(0, Math.round(story.ratingCount * adjusted))]
    }),
  )
}

/* Library -------------------------------------------------------------- */

export function getContinueReading(limit = 4): Promise<ReadingEntry[]> {
  const results = db.readingHistory
    .filter((entry) => entry.shelf === 'reading')
    .sort((a, b) => new Date(b.lastReadAt).getTime() - new Date(a.lastReadAt).getTime())
    .map((entry) => toReadingEntry(entry.id))
    .filter((entry): entry is ReadingEntry => entry !== null)
    .slice(0, limit)

  return delay(results, 220)
}

export function getLibrary(shelf: LibraryShelf | 'bookmarks'): Promise<ReadingEntry[]> {
  const results = db.readingHistory
    .filter((entry) => (shelf === 'bookmarks' ? entry.bookmarked : entry.shelf === shelf))
    .sort((a, b) => new Date(b.lastReadAt).getTime() - new Date(a.lastReadAt).getTime())
    .map((entry) => toReadingEntry(entry.id))
    .filter((entry): entry is ReadingEntry => entry !== null)

  return delay(results)
}

export function getReadingEntryForStory(storyId: string): Promise<ReadingEntry | null> {
  const history = db.readingHistory.find((entry) => entry.storyId === storyId)
  return delay(history ? toReadingEntry(history.id) : null, 120)
}

/* Gamification --------------------------------------------------------- */

export interface BadgeWithProgress {
  badge: Badge
  earned: boolean
  earnedAt: string | null
  progress: number
}

export function getBadges(): Promise<BadgeWithProgress[]> {
  const byId = new Map<string, UserBadge>(
    db.userBadges.map((entry) => [entry.badgeId, entry]),
  )

  const results = db.badges.map((badge) => {
    const owned = byId.get(badge.id)
    return {
      badge,
      earned: Boolean(owned?.earnedAt),
      earnedAt: owned?.earnedAt ?? null,
      progress: owned?.progress ?? 0,
    }
  })

  return delay(results, 200)
}

/* Challenges ----------------------------------------------------------- */

export function getChallenges(): Promise<WritingChallenge[]> {
  return delay(db.challenges, 200)
}

export function getChallenge(slug: string): Promise<WritingChallenge> {
  const challenge = db.challenges.find((item) => item.slug === slug || item.id === slug)
  if (!challenge) return Promise.reject(new NotFoundError('That challenge'))
  return delay(challenge, 200)
}

export interface LeaderboardRow extends ChallengeEntry {
  user: User
  story: Story
}

export function getChallengeLeaderboard(challengeId: string): Promise<LeaderboardRow[]> {
  const results = db.challengeEntries
    .filter((entry) => entry.challengeId === challengeId)
    .map((entry) => ({
      ...entry,
      user: db.userById.get(entry.userId) ?? db.currentUser,
      story: db.storyById.get(entry.storyId) ?? (db.stories[0] as Story),
    }))
    .sort((a, b) => a.rank - b.rank)

  return delay(results, 220)
}

/* Clubs ---------------------------------------------------------------- */

export interface ClubWithMeta extends BookClub {
  owner: User
  currentStory: StoryWithMeta | null
  membership: { role: string } | null
  genres: Genre[]
}

function clubWithMeta(club: BookClub): ClubWithMeta {
  const currentStory = club.currentStoryId
    ? db.storyById.get(club.currentStoryId)
    : undefined
  const membership = db.clubMemberships.find((entry) => entry.clubId === club.id)

  return {
    ...club,
    owner: db.userById.get(club.ownerId) ?? db.currentUser,
    currentStory: currentStory ? withMeta(currentStory) : null,
    membership: membership ? { role: membership.role } : null,
    genres: club.genreIds
      .map((id) => db.genreById.get(id))
      .filter((genre): genre is Genre => genre !== undefined),
  }
}

export function getClubs(): Promise<ClubWithMeta[]> {
  return delay(db.bookClubs.map(clubWithMeta), 220)
}

export function getClub(slug: string): Promise<ClubWithMeta> {
  const club = db.bookClubs.find((item) => item.slug === slug || item.id === slug)
  if (!club) return Promise.reject(new NotFoundError('That book club'))
  return delay(clubWithMeta(club), 200)
}

export interface DiscussionWithUser extends ClubDiscussion {
  user: User
}

export function getClubDiscussions(clubId: string): Promise<DiscussionWithUser[]> {
  const results = db.clubDiscussions
    .filter((thread) => thread.clubId === clubId)
    .map((thread) => ({
      ...thread,
      user: db.userById.get(thread.userId) ?? db.currentUser,
    }))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  return delay(results, 200)
}

/* Channels ------------------------------------------------------------- */

export interface ChannelWithMeta extends BroadcastChannel {
  author: User
  subscribed: boolean
}

function channelWithMeta(channel: BroadcastChannel): ChannelWithMeta {
  return {
    ...channel,
    author: db.userById.get(channel.authorId) ?? db.currentUser,
    subscribed: db.channelSubscriptions.some((entry) => entry.channelId === channel.id),
  }
}

export function getChannels(): Promise<ChannelWithMeta[]> {
  return delay(db.channels.map(channelWithMeta), 200)
}

export function getChannel(slug: string): Promise<ChannelWithMeta> {
  const channel = db.channels.find((item) => item.slug === slug || item.id === slug)
  if (!channel) return Promise.reject(new NotFoundError('That channel'))
  return delay(channelWithMeta(channel), 200)
}

export function getChannelPosts(channelId: string): Promise<ChannelPost[]> {
  const results = db.channelPosts
    .filter((post) => post.channelId === channelId)
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())

  return delay(results, 200)
}

/* Author ---------------------------------------------------------------- */

export interface AuthorOverview {
  totalViews: number
  totalReads: number
  averageRating: number
  engagementRate: number
  followers: number
  series: Array<{ date: string; views: number; reads: number }>
  stories: StoryWithMeta[]
}

export function getAuthorOverview(authorId: string): Promise<AuthorOverview> {
  const owned = db.stories
    .filter((story) => db.myStoryIds.includes(story.id) || story.authorId === authorId)
    .map(withMeta)

  const totalViews = owned.reduce((sum, story) => sum + story.viewCount, 0)
  const totalReads = Math.round(totalViews * 0.46)
  const rated = owned.filter((story) => story.ratingCount > 0)
  const averageRating =
    rated.reduce((sum, story) => sum + story.ratingAverage, 0) / (rated.length || 1)
  const engagement = owned.reduce(
    (sum, story) => sum + story.likeCount + story.commentCount,
    0,
  )

  const series = owned
    .map((story) => db.viewSeries(story.id))
    .reduce<Array<{ date: string; views: number; reads: number }>>((totals, current) => {
      if (totals.length === 0) return [...current]
      return totals.map((point, index) => ({
        date: point.date,
        views: point.views + (current[index]?.views ?? 0),
        reads: point.reads + (current[index]?.reads ?? 0),
      }))
    }, [])

  return delay({
    totalViews,
    totalReads,
    averageRating: Number(averageRating.toFixed(2)),
    engagementRate: Number(((engagement / (totalViews || 1)) * 100).toFixed(1)),
    followers: db.currentUser.followerCount,
    series,
    stories: owned,
  })
}

export function getMyStories(): Promise<StoryWithMeta[]> {
  const results = db.stories
    .filter((story) => db.myStoryIds.includes(story.id))
    .map(withMeta)
  return delay(results, 200)
}

export { db }
