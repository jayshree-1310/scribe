/**
 * What is left of the in-memory dataset the UI was built against.
 *
 * One object. Everything else went as its feature got an endpoint -- the
 * stories, chapters, books, shelves, comments, ratings, reading history,
 * clubs, channels, challenges and badges first, the genre list once
 * `GET /api/stories/genres` served real rows with real counts, and the author
 * directory last, when Task 16 gave the onboarding author picker
 * `GET /api/recommendations/authors` to read instead.
 *
 * `currentUser` survives because a `Session`'s `User` carries fields
 * `auth.User` has no columns for -- an avatar hue, follower and following
 * counts, reading stats -- and `AuthProvider` spreads these under the real
 * profile so those fields have *something*. They are decoration, and every
 * page that shows a real number asks the API for it: `ProfilePage` reads its
 * own counts, `BadgesPage` its own progress, the author pages their own
 * analytics.
 *
 * Task 17 removes this file, along with `data/api.ts` and the mock-shaped
 * halves of `types/domain.ts`.
 */

import type { User } from '../types/domain'

/** Fixed "now", so the joined date does not drift between reloads. */
const NOW = new Date('2026-09-08T09:00:00.000Z')

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86400000).toISOString()
}

/** The presentational half of the signed-in reader. See the header. */
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
