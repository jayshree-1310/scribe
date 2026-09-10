/**
 * What is left of the mock data layer.
 *
 * Stories, chapters, books, shelves, comments, ratings and reading history all
 * come from the API now -- see `data/stories-api.ts`, `data/books-api.ts` and
 * `data/account-api.ts`. What remains here are the features with no endpoints
 * yet: clubs, channels, challenges, badges and the author directory. Each one
 * goes the same way as its API lands.
 */

import * as db from './mock-db'
import type {
  Badge,
  BookClub,
  BroadcastChannel,
  ChallengeEntry,
  ChannelPost,
  ClubDiscussion,
  Genre,
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

/* Reference data ------------------------------------------------------- */

export function getAuthors(): Promise<User[]> {
  return delay(db.authors, 140)
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
}

export function getChallengeLeaderboard(challengeId: string): Promise<LeaderboardRow[]> {
  const results = db.challengeEntries
    .filter((entry) => entry.challengeId === challengeId)
    .map((entry) => ({
      ...entry,
      user: db.userById.get(entry.userId) ?? db.currentUser,
    }))
    .sort((a, b) => a.rank - b.rank)

  return delay(results, 220)
}

/* Clubs ---------------------------------------------------------------- */

export interface ClubWithMeta extends BookClub {
  owner: User
  /**
   * A club's current read points at a story, and clubs have no endpoint yet,
   * so there is nothing to resolve `currentStoryId` against: always null for
   * now. The cards already render a "no current read" state.
   */
  currentStory: StoryWithMeta | null
  membership: { role: string } | null
  genres: Genre[]
}

function clubWithMeta(club: BookClub): ClubWithMeta {
  const membership = db.clubMemberships.find((entry) => entry.clubId === club.id)

  return {
    ...club,
    owner: db.userById.get(club.ownerId) ?? db.currentUser,
    currentStory: null,
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

/**
 * The remaining fixtures, for the one consumer that needs them directly:
 * `AuthProvider` fills the presentational half of a session (avatar hue,
 * follower counts, reading stats) that the API does not carry yet.
 */
export { db }
