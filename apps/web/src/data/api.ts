/**
 * What is left of the mock data layer.
 *
 * One export, and it is not a fetch. Stories, chapters, books, shelves,
 * comments, ratings, reading history, clubs, channels, challenges, badges,
 * notifications, reports, preferences, recommendations and the author
 * directory all come from the API now -- see `data/stories-api.ts`,
 * `data/books-api.ts`, `data/account-api.ts`, `data/preferences-api.ts` and
 * `data/recommendations-api.ts` among the rest.
 *
 * The author directory was the last *function* here, read by the onboarding
 * author picker. Task 16 replaced it with `GET /api/recommendations/authors`,
 * which ranks real accounts by the genres the reader just saved -- so the step
 * follows people who exist instead of fixtures who do not.
 *
 * What survives is `db.currentUser`, for the one consumer that needs it
 * directly: `AuthProvider` fills the presentational half of a session (avatar
 * hue, follower counts, reading stats) that `auth.User` has no columns for.
 * Task 17 is the sweep that removes it.
 */

import * as db from './mock-db'

export { db }
