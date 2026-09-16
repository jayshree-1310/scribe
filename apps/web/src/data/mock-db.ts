/**
 * In-memory dataset backing the UI while the Scribe API is being built.
 *
 * Everything here is deterministic: a seeded PRNG derives counts and dates from
 * stable ids, so the same story always has the same numbers across reloads and
 * across light/dark screenshots. `src/data/api.ts` is the only module that
 * reads this — swap that file for real fetches and the UI is unchanged.
 */

import type { Genre, User } from '../types/domain'

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

/* Stories, chapters, reading history and badges -------------------------
 *
 * Deliberately absent. Stories, their chapters, comments, ratings, reading
 * history and badges are served by the API now (`data/stories-api.ts`,
 * `data/books-api.ts`, `data/gamification-api.ts`) and the only content in the
 * app is what the seed scripts put in the database:
 *
 *   pnpm --filter api seed:books      # imported catalogue editions
 *   pnpm --filter api seed:stories    # authored stories with chapters
 *
 * What remains above is the author directory, the one fixture whose feature
 * still has no endpoint.
 */

export { NOW, daysAgo }
