/**
 * In-memory dataset backing the UI while the Scribe API is being built.
 *
 * Everything here is deterministic: a seeded PRNG derives counts and dates from
 * stable ids, so the same story always has the same numbers across reloads and
 * across light/dark screenshots. `src/data/api.ts` is the only module that
 * reads this — swap that file for real fetches and the UI is unchanged.
 */

import type {
  Badge,
  ChallengeEntry,
  Genre,
  User,
  UserBadge,
  WritingChallenge,
} from '../types/domain'

/* Deterministic helpers ------------------------------------------------ */

function seeded(seed: string): () => number {
  let hash = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return () => {
    hash ^= hash << 13
    hash ^= hash >>> 17
    hash ^= hash << 5
    return ((hash >>> 0) % 100000) / 100000
  }
}

/** Fixed "now" so relative dates stay stable in tests and screenshots. */
const NOW = new Date('2026-09-08T09:00:00.000Z')

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86400000).toISOString()
}

function daysAhead(days: number): string {
  return new Date(NOW.getTime() + days * 86400000).toISOString()
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)] as T
}

function between(random: () => number, min: number, max: number): number {
  return Math.floor(min + random() * (max - min))
}

/* Genres --------------------------------------------------------------- */

export const genres: Genre[] = [
  { id: 'g-fantasy', name: 'Fantasy', slug: 'fantasy', hue: 268, storyCount: 12840, description: 'Magic systems, invented worlds and impossible maps.' },
  { id: 'g-romance', name: 'Romance', slug: 'romance', hue: 342, storyCount: 18320, description: 'Slow burns, second chances and terrible timing.' },
  { id: 'g-mystery', name: 'Mystery', slug: 'mystery', hue: 202, storyCount: 7410, description: 'Clues in plain sight and narrators you should not trust.' },
  { id: 'g-thriller', name: 'Thriller', slug: 'thriller', hue: 6, storyCount: 6980, description: 'Short chapters, shorter fuses.' },
  { id: 'g-scifi', name: 'Sci-Fi', slug: 'sci-fi', hue: 190, storyCount: 8115, description: 'Near futures, deep space and the ethics of both.' },
  { id: 'g-historical', name: 'Historical Fiction', slug: 'historical-fiction', hue: 32, storyCount: 4260, description: 'Real centuries, invented lives.' },
  { id: 'g-ya', name: 'Young Adult', slug: 'young-adult', hue: 288, storyCount: 15070, description: 'First everything, at full volume.' },
  { id: 'g-horror', name: 'Horror', slug: 'horror', hue: 150, storyCount: 3890, description: 'Quiet dread and the thing behind the door.' },
  { id: 'g-poetry', name: 'Poetry', slug: 'poetry', hue: 224, storyCount: 5240, description: 'Line breaks that earn their keep.' },
  { id: 'g-adventure', name: 'Adventure', slug: 'adventure', hue: 96, storyCount: 6630, description: 'Long roads, bad weather, good company.' },
]

export const genreById = new Map(genres.map((genre) => [genre.id, genre]))

/* Users ---------------------------------------------------------------- */

interface AuthorSeed {
  id: string
  username: string
  displayName: string
  bio: string
  hue: number
}

const authorSeeds: AuthorSeed[] = [
  { id: 'u-ilse', username: 'ilsevandermeer', displayName: 'Ilse van der Meer', bio: 'Writes cold northern fantasy. Cartographer by training, which explains the maps.', hue: 268 },
  { id: 'u-adeyemi', username: 'k_adeyemi', displayName: 'Kemi Adeyemi', bio: 'Romance with sharp edges. Lagos to Lisbon. Tea over coffee, always.', hue: 342 },
  { id: 'u-solano', username: 'rsolano', displayName: 'Rafael Solano', bio: 'Detective fiction set in cities that do not sleep because the rent is due.', hue: 202 },
  { id: 'u-nakamura', username: 'haru_nakamura', displayName: 'Haru Nakamura', bio: 'Quiet science fiction about repairing things — machines, mostly people.', hue: 190 },
  { id: 'u-okonkwo', username: 'amaraokonkwo', displayName: 'Amara Okonkwo', bio: 'Historical fiction, 19th century, women who kept the ledgers.', hue: 32 },
  { id: 'u-lindqvist', username: 'e_lindqvist', displayName: 'Elin Lindqvist', bio: 'Horror that happens in daylight. Sorry in advance.', hue: 150 },
  { id: 'u-mehta', username: 'priyamehta', displayName: 'Priya Mehta', bio: 'YA about ambitious girls and the institutions that underestimate them.', hue: 288 },
  { id: 'u-abadi', username: 'yusufabadi', displayName: 'Yusuf Abadi', bio: 'Poems, mostly at night. Occasional essays when the poems refuse.', hue: 224 },
  { id: 'u-fairweather', username: 'j_fairweather', displayName: 'Jo Fairweather', bio: 'Adventure serials. I have fallen off most things worth falling off.', hue: 96 },
  { id: 'u-castellanos', username: 'lcastellanos', displayName: 'Lucía Castellanos', bio: 'Thrillers with short chapters, because you have a train to catch.', hue: 6 },
]

function makeAuthor(seed: AuthorSeed): User {
  const random = seeded(seed.id)
  return {
    id: seed.id,
    username: seed.username,
    displayName: seed.displayName,
    email: `${seed.username}@scribe.example`,
    bio: seed.bio,
    avatarHue: seed.hue,
    joinedAt: daysAgo(between(random, 420, 1600)),
    isAuthor: true,
    followerCount: between(random, 4200, 186000),
    followingCount: between(random, 40, 620),
    stats: {
      storiesRead: between(random, 60, 340),
      chaptersRead: between(random, 900, 5200),
      storiesPublished: 0,
      totalViews: 0,
      averageRating: null,
      readingStreakDays: between(random, 3, 90),
      minutesReadThisWeek: between(random, 60, 700),
    },
  }
}

export const authors: User[] = authorSeeds.map(makeAuthor)

/** The signed-in reader used across the app. */
export const currentUser: User = {
  id: 'u-me',
  username: 'jayshree',
  displayName: 'Jayshree Upadhyay',
  email: 'jayshree@scribe.example',
  bio: 'Reader first, writer on Sundays. Currently deep in northern fantasy and anything with a map in the front matter.',
  avatarHue: 24,
  joinedAt: daysAgo(268),
  isAuthor: true,
  followerCount: 1284,
  followingCount: 96,
  stats: {
    storiesRead: 74,
    chaptersRead: 1146,
    storiesPublished: 2,
    totalViews: 48210,
    averageRating: 4.31,
    readingStreakDays: 7,
    minutesReadThisWeek: 284,
  },
}

export const users: User[] = [currentUser, ...authors]
export const userById = new Map(users.map((user) => [user.id, user]))

/* Stories, chapters and reading history ---------------------------------
 *
 * Deliberately absent. Stories, their chapters, comments, ratings and reading
 * history are served by the API now (`data/stories-api.ts`, `data/books-api.ts`)
 * and the only content in the app is what the seed scripts put in the database:
 *
 *   pnpm --filter api seed:books      # imported catalogue editions
 *   pnpm --filter api seed:stories    # authored stories with chapters
 *
 * What remains below is the data whose features have no endpoints yet -- clubs,
 * channels, challenges, badges and the author directory.
 */

/* Gamification --------------------------------------------------------- */

export const badges: Badge[] = [
  { id: 'b-first-story', name: 'First Story', description: 'Published your first story on Scribe.', icon: 'book', tier: 'bronze', criteria: 'Publish one story', category: 'writing' },
  { id: 'b-first-chapter', name: 'First Chapter', description: 'Published your first chapter.', icon: 'pencil', tier: 'bronze', criteria: 'Publish one chapter', category: 'writing' },
  { id: 'b-first-review', name: 'First Review', description: 'Left your first review on a story.', icon: 'star', tier: 'bronze', criteria: 'Review one story', category: 'community' },
  { id: 'b-streak-7', name: '7 Day Streak', description: 'Read something every day for a week.', icon: 'flame', tier: 'silver', criteria: 'Read 7 days in a row', category: 'reading' },
  { id: 'b-chapters-100', name: '100 Chapters', description: 'Read one hundred chapters.', icon: 'library', tier: 'silver', criteria: 'Read 100 chapters', category: 'reading' },
  { id: 'b-rising-author', name: 'Rising Author', description: 'Reached 1,000 reads across your stories.', icon: 'trend', tier: 'silver', criteria: 'Earn 1,000 reads', category: 'writing' },
  { id: 'b-popular-writer', name: 'Popular Writer', description: 'Reached 50,000 reads across your stories.', icon: 'crown', tier: 'gold', criteria: 'Earn 50,000 reads', category: 'writing' },
  { id: 'b-club-regular', name: 'Book Club Regular', description: 'Posted in club discussions ten weeks running.', icon: 'users', tier: 'silver', criteria: 'Post 10 weeks in a row', category: 'community' },
  { id: 'b-marathon', name: 'Marathon Reader', description: 'Read for 500 minutes in a single week.', icon: 'clock', tier: 'gold', criteria: 'Read 500 minutes in a week', category: 'reading' },
  { id: 'b-challenge-win', name: 'Challenge Winner', description: 'Placed first in a writing challenge.', icon: 'trophy', tier: 'gold', criteria: 'Win a writing challenge', category: 'writing' },
  { id: 'b-critic', name: 'Thoughtful Critic', description: 'Wrote 25 reviews other readers found helpful.', icon: 'quote', tier: 'silver', criteria: 'Write 25 helpful reviews', category: 'community' },
  { id: 'b-nightowl', name: 'Night Owl', description: 'Read after midnight thirty times.', icon: 'moon', tier: 'bronze', criteria: 'Read after midnight 30 times', category: 'reading' },
]

export const userBadges: UserBadge[] = [
  { badgeId: 'b-first-story', userId: currentUser.id, earnedAt: daysAgo(180), progress: 1 },
  { badgeId: 'b-first-chapter', userId: currentUser.id, earnedAt: daysAgo(182), progress: 1 },
  { badgeId: 'b-first-review', userId: currentUser.id, earnedAt: daysAgo(174), progress: 1 },
  { badgeId: 'b-streak-7', userId: currentUser.id, earnedAt: daysAgo(1), progress: 1 },
  { badgeId: 'b-chapters-100', userId: currentUser.id, earnedAt: daysAgo(96), progress: 1 },
  { badgeId: 'b-rising-author', userId: currentUser.id, earnedAt: daysAgo(42), progress: 1 },
  { badgeId: 'b-nightowl', userId: currentUser.id, earnedAt: daysAgo(9), progress: 1 },
  { badgeId: 'b-popular-writer', userId: currentUser.id, earnedAt: null, progress: 0.64 },
  { badgeId: 'b-club-regular', userId: currentUser.id, earnedAt: null, progress: 0.4 },
  { badgeId: 'b-marathon', userId: currentUser.id, earnedAt: null, progress: 0.57 },
  { badgeId: 'b-challenge-win', userId: currentUser.id, earnedAt: null, progress: 0.2 },
  { badgeId: 'b-critic', userId: currentUser.id, earnedAt: null, progress: 0.72 },
]

/* Challenges ----------------------------------------------------------- */

export const challenges: WritingChallenge[] = [
  {
    id: 'wc-septflash', title: 'September Flash Fiction', slug: 'september-flash-fiction',
    prompt: 'A door that only opens for one person.',
    description: 'One thousand words or fewer. Any genre. The door can be literal, and it is more interesting when it is not. Entries are read blind by three guest authors and the community vote decides the shortlist.',
    hue: 268, state: 'active', startsAt: daysAgo(8), endsAt: daysAhead(6),
    participantCount: 2841, entryCount: 1902, wordTarget: 1000, hostId: 'u-ilse',
  },
  {
    id: 'wc-firstline', title: 'Steal This First Line', slug: 'steal-this-first-line',
    prompt: '"I have been dead for a week and nobody has noticed."',
    description: 'Start with the line exactly as written, then go anywhere. Up to 5,000 words. Last year\'s winner turned it into a novel that has since been read 400,000 times.',
    hue: 6, state: 'active', startsAt: daysAgo(3), endsAt: daysAhead(18),
    participantCount: 1264, entryCount: 613, wordTarget: 5000, hostId: 'u-castellanos',
  },
  {
    id: 'wc-slowromance', title: 'The Slowest Burn', slug: 'the-slowest-burn',
    prompt: 'Two people, one shared task, no confession.',
    description: 'A romance challenge with a rule: nobody may say how they feel. Show it in the work they do together.',
    hue: 342, state: 'active', startsAt: daysAgo(14), endsAt: daysAhead(2),
    participantCount: 3902, entryCount: 2611, wordTarget: 3000, hostId: 'u-adeyemi',
  },
  {
    id: 'wc-octhorror', title: 'Daylight Horror', slug: 'daylight-horror',
    prompt: 'Something is wrong and it is two in the afternoon.',
    description: 'No night scenes. No basements. Make noon frightening.',
    hue: 150, state: 'upcoming', startsAt: daysAhead(9), endsAt: daysAhead(39),
    participantCount: 412, entryCount: 0, wordTarget: 4000, hostId: 'u-lindqvist',
  },
  {
    id: 'wc-worldbuild', title: 'One Map, Many Stories', slug: 'one-map-many-stories',
    prompt: 'Everyone writes in the same invented country.',
    description: 'A shared-setting challenge. The map is published on day one; you claim a region and write it.',
    hue: 96, state: 'upcoming', startsAt: daysAhead(21), endsAt: daysAhead(72),
    participantCount: 188, entryCount: 0, wordTarget: null, hostId: 'u-fairweather',
  },
  {
    id: 'wc-augpoetry', title: 'Thirty Poems, Thirty Days', slug: 'thirty-poems-thirty-days',
    prompt: 'One poem a day for the month.',
    description: 'Completed in August. 1,204 writers finished all thirty days.',
    hue: 224, state: 'completed', startsAt: daysAgo(68), endsAt: daysAgo(38),
    participantCount: 4120, entryCount: 3811, wordTarget: null, hostId: 'u-abadi',
  },
  {
    id: 'wc-junemystery', title: 'The Closed Room', slug: 'the-closed-room',
    prompt: 'A crime with only one possible suspect, who did not do it.',
    description: 'Completed in June. Judged by three crime novelists.',
    hue: 202, state: 'completed', startsAt: daysAgo(120), endsAt: daysAgo(90),
    participantCount: 2210, entryCount: 1640, wordTarget: 6000, hostId: 'u-solano',
  },
]

export const challengeEntries: ChallengeEntry[] = challenges
  .filter((challenge) => challenge.state !== 'upcoming')
  .flatMap((challenge) => {
    const random = seeded(`${challenge.id}-entries`)
    return Array.from({ length: 8 }, (_, index) => ({
      id: `${challenge.id}-e${index}`,
      challengeId: challenge.id,
      userId: (pick(users, random) as User).id,
      // No story to point at: stories live in the database now, and the
      // challenges API that would join them does not exist yet.
      storyId: '',
      submittedAt: daysAgo(between(random, 1, 20)),
      voteCount: 4200 - index * between(random, 180, 420),
      rank: index + 1,
    }))
  })

export { NOW, daysAgo, daysAhead }
