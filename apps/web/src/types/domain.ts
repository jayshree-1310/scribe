/**
 * Scribe domain types.
 *
 * These mirror the backend entities (auth / content / engagement /
 * gamification / challenges / clubs / channels) so that swapping the mock data
 * layer in `src/data/api.ts` for real endpoints is a change of transport only.
 * Timestamps are ISO-8601 strings.
 */

/* auth ---------------------------------------------------------------- */

export interface User {
  id: string
  username: string
  displayName: string
  email: string
  bio: string
  /** Uploaded picture; null falls the UI back to the generated monogram. */
  avatarUrl?: string | null
  avatarHue: number
  joinedAt: string
  isAuthor: boolean
  followerCount: number
  followingCount: number
  /** Aggregates the backend exposes on the profile endpoint. */
  stats: UserStats
}

export interface UserStats {
  storiesRead: number
  chaptersRead: number
  storiesPublished: number
  totalViews: number
  averageRating: number | null
  readingStreakDays: number
  minutesReadThisWeek: number
}

/** The signed-in user, plus the preferences captured during onboarding. */
export interface Session {
  user: User
  onboarded: boolean
  favoriteGenreIds: string[]
  followedAuthorIds: string[]
  wantsToWrite: boolean
}

/* content ------------------------------------------------------------- */

export interface Genre {
  id: string
  name: string
  slug: string
  /** Base hue used for chips and generated cover art. */
  hue: number
  storyCount: number
  description: string
}

export type StoryStatus = 'draft' | 'ongoing' | 'completed' | 'hiatus'

export interface Story {
  id: string
  title: string
  slug: string
  synopsis: string
  authorId: string
  status: StoryStatus
  genreIds: string[]
  kidsAppropriate: boolean
  publishedAt: string | null
  updatedAt: string
  chapterCount: number
  wordCount: number
  viewCount: number
  likeCount: number
  commentCount: number
  ratingAverage: number
  ratingCount: number
  /** Two-line pull quote shown on feature cards. */
  tagline: string
}

export type MultimediaKind = 'image' | 'audio' | 'video'

export interface Multimedia {
  id: string
  chapterId: string
  kind: MultimediaKind
  caption: string
  /** Duration in seconds for audio/video. */
  durationSeconds?: number
}

export interface Chapter {
  id: string
  storyId: string
  number: number
  title: string
  /** Paragraphs of prose; the reader renders these directly. */
  paragraphs: string[]
  publishedAt: string | null
  wordCount: number
  readingMinutes: number
  viewCount: number
  multimedia: Multimedia[]
}

/* engagement ---------------------------------------------------------- */

export interface Comment {
  id: string
  storyId: string
  chapterId: string | null
  userId: string
  body: string
  createdAt: string
  likeCount: number
  replyCount: number
}

export interface Rating {
  id: string
  storyId: string
  userId: string
  score: number
  review: string | null
  createdAt: string
}

export interface ReadingHistory {
  id: string
  userId: string
  storyId: string
  chapterId: string
  /** 0–1 through the current chapter. */
  chapterProgress: number
  /** 0–1 through the whole story. */
  storyProgress: number
  lastReadAt: string
  shelf: LibraryShelf
  bookmarked: boolean
}

export type LibraryShelf = 'reading' | 'completed' | 'saved'

/* gamification -------------------------------------------------------- */

export type BadgeTier = 'bronze' | 'silver' | 'gold'

export interface Badge {
  id: string
  name: string
  description: string
  /** Icon key resolved by the `Icon` component. */
  icon: string
  tier: BadgeTier
  /** How the badge is earned, shown on locked badges. */
  criteria: string
  category: 'reading' | 'writing' | 'community'
}

export interface UserBadge {
  badgeId: string
  userId: string
  earnedAt: string | null
  /** 0–1 toward earning it; 1 once earned. */
  progress: number
}

/* challenges ---------------------------------------------------------- */

export type ChallengeState = 'active' | 'upcoming' | 'completed'

export interface WritingChallenge {
  id: string
  title: string
  slug: string
  prompt: string
  description: string
  hue: number
  state: ChallengeState
  startsAt: string
  endsAt: string
  participantCount: number
  entryCount: number
  wordTarget: number | null
  hostId: string
}

export interface ChallengeEntry {
  id: string
  challengeId: string
  userId: string
  storyId: string
  submittedAt: string
  voteCount: number
  rank: number
}

/* clubs --------------------------------------------------------------- */

export interface BookClub {
  id: string
  name: string
  slug: string
  description: string
  hue: number
  ownerId: string
  memberCount: number
  currentStoryId: string | null
  discussionCount: number
  isPrivate: boolean
  createdAt: string
  genreIds: string[]
}

export type ClubRole = 'owner' | 'moderator' | 'member'

export interface ClubMembership {
  clubId: string
  userId: string
  role: ClubRole
  joinedAt: string
}

export interface ClubDiscussion {
  id: string
  clubId: string
  userId: string
  title: string
  body: string
  createdAt: string
  replyCount: number
  /** Chapter the thread is anchored to, when relevant. */
  chapterNumber: number | null
}

/* channels ------------------------------------------------------------ */

export interface BroadcastChannel {
  id: string
  name: string
  slug: string
  description: string
  authorId: string
  subscriberCount: number
  postCount: number
  createdAt: string
}

export interface ChannelSubscriber {
  channelId: string
  userId: string
  subscribedAt: string
}

export interface ChannelPost {
  id: string
  channelId: string
  title: string
  body: string
  publishedAt: string
  likeCount: number
  commentCount: number
  /** Set when the post announces a chapter. */
  linkedStoryId: string | null
}

/* view models --------------------------------------------------------- */

/** A story joined with the data every card and detail header needs. */
export interface StoryWithMeta extends Story {
  author: User
  genres: Genre[]
}

/** A library/continue-reading entry joined with its story and chapter. */
export interface ReadingEntry {
  history: ReadingHistory
  story: StoryWithMeta
  chapter: Pick<Chapter, 'id' | 'number' | 'title'>
}

export interface DiscoverFilters {
  search: string
  genreId: string | null
  sort: DiscoverSort
  status: StoryStatus | 'all'
  kidsOnly: boolean
}

export const DISCOVER_SORTS = [
  'trending',
  'popular-week',
  'top-rated',
  'recent',
  'recommended',
] as const

export type DiscoverSort = (typeof DISCOVER_SORTS)[number]

export const DISCOVER_SORT_LABELS: Record<DiscoverSort, string> = {
  trending: 'Trending now',
  'popular-week': 'Popular this week',
  'top-rated': 'Highest rated',
  recent: 'Recently published',
  recommended: 'Recommended for you',
}
