# Scribe — Implementation Backlog

Derived from the gap between the frontend surface (`apps/web/src/pages`, still
mostly served by the mock `data/api.ts` + `mock-db.ts`) and the API
(`apps/api/src/routes`, currently auth + books + library only).

GenAI features are tracked separately in `AI-BACKLOG.md`, which notes which of
the tasks below it depends on.

## House rules every task inherits

Paste this block at the top of any task prompt below.

> **Conventions (read before writing code).**
> - API layout: thin router in `apps/api/src/routes/<name>.ts`, all logic in
>   `apps/api/src/services/<name>.ts`, mounted in `apps/api/src/app.ts`.
> - Validate every `req.query` / `req.body` / `req.params` with `parseOrThrow`
>   from `lib/validate.js` and a zod schema. Never trust ids from the body for
>   identity — read the caller from `requireUserId(res)`
>   (`middleware/current-user.js`).
> - Errors: throw `HttpError` from `lib/http-error.js`; the error handler
>   formats them. Handlers are `try { ... } catch (error) { next(error) }`.
> - Auth: `router.use(requireUser)` for routers that need a signed-in user;
>   for mixed public/private routes read the optional user per-handler.
> - Schema changes go in `apps/api/src/prisma/contract.prisma`, in the right
>   `namespace`, followed by a migration under `apps/api/migrations/app/`.
> - Tests: integration tests next to the route (`<name>.test.ts`) using
>   `TestApi` from `src/test/harness.ts`. Register any new entity type in the
>   harness `created` bookkeeping so teardown stays clean.
> - Frontend: real endpoints live in `apps/web/src/data/<name>-api.ts` and go
>   through `lib/api-client.ts` (which handles the access token + refresh).
>   Follow the shape of `books-api.ts`. Delete the mock functions you replace
>   from `data/api.ts` and prune `mock-db.ts` once nothing imports them.
> - Match the surrounding comment style: comments explain *why*, not *what*.
> - Content model: there is one work entity, `content.Story`; catalogue books are
>   `Story` rows with `isbn` set and no chapters. See `docs/content-model.md` for
>   the decision and the contract additions (`slug`, `source`, publish state)
>   that Task 1 owns.

---

## Task 2 — Reading progress & history

The Home page's core loop. `engagement.ReadingHistory` exists, no routes.

**Prompt:**

> Implement reading progress. `engagement.ReadingHistory` already exists in
> `contract.prisma` — read it first and extend it if it cannot express a resume
> point (needs at minimum: story, chapter, scroll/character offset, percent
> complete, `lastReadAt`). Migration required if you change it.
>
> API — `apps/api/src/services/reading.ts` + `routes/reading.ts` at
> `/api/reading` (all behind `requireUser`):
> - `PUT /progress` — upsert progress for `{ storyId, chapterId, offset }`.
>   Idempotent; called frequently from the reader, so it must be a single
>   upsert, not read-then-write.
> - `GET /continue?limit=` — most recently read stories with resume target,
>   newest first, one row per story.
> - `GET /progress/:storyId` — resume point for one story, or null.
> - `DELETE /progress/:storyId` — clear it.
>
> Also update `auth.User.readingStreak` when progress is recorded: a day-boundary
> streak in the user's stored timezone, or UTC if none is stored. Put the streak
> rule in one function in the service with a comment explaining the boundary
> choice, and unit-test it directly.
>
> FE — extend `data/stories-api.ts` (or a new `reading-api.ts`). Wire
> `pages/ReaderPage.tsx` to save progress on a debounced scroll (reuse
> `hooks/useDebouncedValue.ts`) and to restore position on mount;
> `components/story/ContinueCard.tsx` and `pages/HomePage.tsx` read from
> `/continue`. Remove `getContinueReading` and `getReadingEntryForStory` from
> `data/api.ts`.
>
> Tests: upsert idempotency, continue-list ordering and per-story dedupe,
> streak increment / same-day no-op / gap reset.

---

## Task 3 — Comments & ratings

`engagement.Comment` and `engagement.Rating` exist, no routes.

**Since the stories task landed:** `getRatingBreakdown` is no longer rendered on
`StoryDetailPage` — it invented a histogram from hardcoded weights, which would
have been a lie next to a real rating count — so `components/charts/RatingBars.tsx`
is currently unused and waits for a real breakdown. `Story.ratingCount` still
does not exist as a column; the stories service computes count and average from
`Rating` rows and falls back to the denormalised `Story.ratingAverage` only when
there are none. Deciding whether to add `ratingCount` and make the columns
authoritative is part of this task. `getComments` / `getRatings` are still called
from `StoryDetailPage` and `ReaderPage`, returning nothing for a real story id.

**Prompt:**

> Implement comments and ratings for stories.
>
> API — `services/engagement.ts` + `routes/engagement.ts`, or mount under the
> stories router, your call — but be consistent and say which in the PR body:
> - `GET /api/stories/:storyId/comments` — paginated, newest first, each with
>   its author summary. Public.
> - `POST /api/stories/:storyId/comments` — body 1–2000 chars, trimmed,
>   rejected if empty after trimming. Requires auth. Rate-limit it with
>   `lib/rate-limit.ts`.
> - `DELETE /api/comments/:id` — author of the comment only; 403 otherwise.
> - `PUT /api/stories/:storyId/rating` — upsert the caller's 1–5 rating.
> - `DELETE /api/stories/:storyId/rating`.
> - `GET /api/stories/:storyId/ratings` — returns `{ average, count,
>   breakdown: { 1..5 -> count }, mine }`, computed from real rows.
>
> `Story.ratingAverage` / `ratingCount` are denormalised — recompute them inside
> the same transaction as any rating write so they cannot drift.
>
> FE — replace `getComments`, `addComment`, `getRatings` and especially
> `getRatingBreakdown` in `data/api.ts` (that last one invents a histogram from
> hardcoded weights at `api.ts:256` — delete it, don't port it). Wire
> `pages/StoryDetailPage.tsx` and `components/charts/RatingBars.tsx` to the real
> breakdown, and `components/ui/Rating.tsx` to submit.
>
> Tests: comment validation and ownership on delete, rating upsert replaces
> rather than duplicates, denormalised average matches a recomputed one after a
> series of writes.

---

## Task 8 — Author analytics

Depends on the authoring task, which has landed. Currently synthesised from
mock view counts.

**Prompt:**

> `apps/web/src/pages/author/AuthorAnalyticsPage.tsx` and
> `AuthorDashboardPage.tsx` render views, reads, average rating, engagement and
> a time series — all invented client-side in `data/api.ts` (`getAuthorOverview`,
> which multiplies view counts by 0.46 to fake a read count).
>
> Make it real. Decide what to actually record: at minimum a story view event
> and a chapter-read event, timestamped, deduped per user per day so a refresh
> does not inflate the numbers. Add the model and migration, and record events
> from the story detail and reader endpoints (asynchronously — a view write must
> never fail or slow the read response).
>
> Then `GET /api/author/analytics?range=7d|30d|90d` returning totals plus a
> daily series, and `GET /api/author/analytics/stories/:id` for the per-story
> breakdown. Aggregate in SQL, not in JS over every row.
>
> FE: rewire both pages onto it; `components/charts/LineChart.tsx` already takes
> a series, so match its shape. Delete `getAuthorOverview` from `data/api.ts`.
>
> Tests: dedupe within a day, range boundary correctness, and that a story with
> no events returns zeroes rather than erroring or omitting days.

---

## Task 9 — Book clubs

**Prompt:**

> Implement book clubs. `clubs.BookClub` and `clubs.ClubMembership` exist in
> `contract.prisma`; there is **no** discussion model, though the FE has one —
> add `clubs.ClubDiscussion` (club, author, body, parent for replies,
> timestamps) plus a migration.
>
> API — `services/clubs.ts` + `routes/clubs.ts` at `/api/clubs`:
> - `GET /` (public, with search and a member count), `GET /:slug` (public,
>   including the caller's membership if any).
> - `POST /` — create; creator becomes `OWNER`.
> - `PATCH /:id`, `DELETE /:id` — `OWNER`/`ADMIN` only.
> - `POST /:id/join`, `DELETE /:id/leave` — the last `OWNER` cannot leave
>   without transferring ownership; return a clear error.
> - `PATCH /:id/members/:userId` — role change, `OWNER` only.
> - `PUT /:id/current-read` — set the club's current story.
> - `GET /:id/discussions`, `POST /:id/discussions` (members only),
>   `DELETE /discussions/:id` (author or club admin).
>
> FE: `data/clubs-api.ts`; rewire `pages/ClubsPage.tsx` and
> `pages/ClubDetailPage.tsx`, remove the club functions from `data/api.ts`.
>
> Tests: role enforcement on every privileged action, last-owner-leave guard,
> non-member posting blocked, join idempotency.

---

## Task 10 — Broadcast channels

**Prompt:**

> Implement broadcast channels. `channels.BroadcastChannel`,
> `ChannelSubscriber` and `ChannelPost` all exist in `contract.prisma`; there
> are no routes.
>
> API — `services/channels.ts` + `routes/channels.ts` at `/api/channels`:
> - `GET /` and `GET /:slug` — public, with subscriber counts and the caller's
>   subscription state when signed in.
> - `POST /` — create (owner is the caller), `PATCH /:id`, `DELETE /:id` — owner
>   only.
> - `POST /:id/subscribe`, `DELETE /:id/subscribe` — idempotent both ways.
> - `GET /:id/posts` — paginated, newest first, public.
> - `POST /:id/posts`, `PATCH /posts/:id`, `DELETE /posts/:id` — owner only.
>
> FE: `data/channels-api.ts`; rewire `pages/ChannelsPage.tsx`,
> `pages/ChannelDetailPage.tsx` and `pages/author/AuthorChannelsPage.tsx`
> (which manages the caller's own channels and composes posts). Remove the
> channel functions from `data/api.ts`.
>
> Tests: owner-only enforcement, subscribe/unsubscribe idempotency, post
> pagination ordering.

---

## Task 11 — Writing challenges & leaderboard

**Prompt:**

> Implement writing challenges. `challenges.WritingChallenge` and
> `ChallengeEntry` exist; no routes.
>
> API — `services/challenges.ts` + `routes/challenges.ts` at `/api/challenges`:
> - `GET /` — active, upcoming and past, derived from the challenge's date
>   window rather than a stored status field. `GET /:slug` — detail plus the
>   caller's entry if any.
> - `POST /:id/enter` — join; rejected outside the submission window, and
>   rejected as a duplicate if already entered.
> - `PUT /entries/:id` — attach or update the submitted story; entrant only.
> - `DELETE /entries/:id` — withdraw.
> - `GET /:id/leaderboard` — ranked rows matching what
>   `pages/ChallengeDetailPage.tsx` renders today (see `LeaderboardRow` in
>   `types/domain.ts`). Define the ranking rule explicitly in one commented
>   function; rank in SQL.
> - Admin create/update of challenges — there is no admin role in the system
>   yet; either add a minimal `isAdmin` flag with a migration or gate it behind
>   a seed script, and say which you chose and why.
>
> FE: `data/challenges-api.ts`; rewire `pages/ChallengesPage.tsx` and
> `pages/ChallengeDetailPage.tsx`, remove the challenge functions from
> `data/api.ts`.
>
> Tests: window boundaries (entering before, during, after), duplicate entry
> rejection, leaderboard tie-breaking is deterministic.

---

## Task 12 — Badges & levels (award engine)

**Prompt:**

> `gamification.Badge` and `UserBadge` exist, `apps/web/src/pages/BadgesPage.tsx`
> renders progress bars, and nothing anywhere ever writes `UserBadge`,
> `User.readerLevel` or `User.authorLevel`.
>
> Build the award engine. Define badge criteria declaratively in one place in
> `services/gamification.ts` (e.g. `{ code, name, description, metric,
> threshold }` over metrics like stories read, chapters read, comments posted,
> ratings given, streak length, stories published, words written) so adding a
> badge is a data change, not a code change. Add an `evaluateBadges(userId)`
> that computes current metric values, awards anything newly earned, is
> idempotent, and returns what was newly awarded. Call it after the events that
> can plausibly move a metric — from the service layer, not the route, and
> without blocking the response.
>
> Derive reader/author levels from the same metrics with a documented curve.
>
> API: `GET /api/badges` — all badges with the caller's progress and earned-at,
> which is exactly what the mock `getBadges` returns today; `GET
> /api/users/:username/badges` for public profiles.
>
> FE: `data/gamification-api.ts`, rewire `pages/BadgesPage.tsx`, remove
> `getBadges` from `data/api.ts`. Surface newly earned badges as a toast.
>
> Tests: idempotent re-award, threshold boundary (at, just below, just above),
> and that seeding a user's metrics then evaluating awards exactly the expected
> set.

---

## Task 13 — Public profiles & follows

**Prompt:**

> `/profile/:username` is a public route in `App.tsx` but there is no
> get-user-by-username endpoint, and there is no follow relationship anywhere in
> `contract.prisma`.
>
> API:
> - `GET /api/users/:username` — public profile: display name, avatar, bio,
>   isAuthor, levels, streak, join date, published story count, follower and
>   following counts. Never leak email or `passwordHash`; write the selection
>   explicitly rather than spreading the row.
> - `GET /api/users/:username/stories` — their published stories, paginated.
> - Add a `Follow` model (follower, following, createdAt, unique pair, self-follow
>   rejected) plus a migration, and `POST/DELETE /api/users/:username/follow`,
>   `GET /api/users/:username/followers` and `/following`.
>
> `auth.User` has no `bio` field — add one if the profile page renders it.
>
> FE: `data/users-api.ts`; rewire `pages/ProfilePage.tsx` to serve both the
> public `/profile/:username` view and the signed-in `/profile` view from the
> same component, with a follow button that reflects state optimistically.
>
> Tests: no sensitive fields in the response body, self-follow rejected,
> follow/unfollow idempotency, counts correct after churn.

---

## Task 14 — Notifications

Depends on Tasks 3, 9, 10, 13.

**Prompt:**

> There is no notification system. Add one, driven by events that already exist
> or are being added: a new post in a channel you subscribe to, a reply to your
> comment, activity in a club you belong to, a new story by an author you follow,
> a badge earned.
>
> Add a `Notification` model (recipient, type, payload, readAt, createdAt) plus a
> migration, and a single `notify()` in `services/notifications.ts` that the
> other services call — do not scatter inserts across routes. Fan-out to
> subscribers must not block the originating request and must not fail it.
>
> API: `GET /api/notifications` (paginated, unread count), `POST
> /api/notifications/:id/read`, `POST /api/notifications/read-all`.
>
> FE: a bell with an unread badge in `components/layout/TopBar.tsx` and a
> dropdown list using the existing `DropdownMenu`. Poll on an interval for now
> and leave a clearly marked seam for websockets/SSE later.
>
> Tests: fan-out to the right recipients only, no self-notification for your own
> actions, unread count accuracy after partial reads.

---

## Task 15 — Moderation & reporting

Depends on Tasks 3 and 9.

**Prompt:**

> Comments, club discussions and channel posts are all user-generated with no
> reporting or moderation path.
>
> Add a `Report` model (reporter, target type, target id, reason, status,
> resolvedBy, timestamps) plus a migration, and `POST /api/reports` (rate-limited,
> one open report per user per target). Add a moderator view: `GET
> /api/moderation/reports` with filters and `POST /api/moderation/reports/:id/resolve`
> taking an action (dismiss, hide content, suspend user). This needs the
> admin/moderator role decision from the challenges task — reuse it, do not
> invent a second one.
>
> Soft-hide rather than hard-delete content so a wrong call is reversible; hidden
> content must disappear from every public read path — audit them all.
>
> FE: a report action in the comment/discussion/post overflow menus with a reason
> dialog. A moderator UI is out of scope for this task unless the API work lands
> early.
>
> Tests: duplicate report rejection, hidden content absent from every public
> list endpoint, non-moderator blocked from the moderation routes.

---

## Task 16 — Onboarding preferences & real recommendations

**Prompt:**

> `apps/web/src/pages/OnboardingPage.tsx` collects genre preferences and throws
> them away — there is no user-preferences model — and `getRecommendedStories`
> in `data/api.ts` fakes personalisation by filtering the mock list.
>
> Add persisted preferences: favourite genres (many-to-many against
> `content.Genre`), preferred content length, and whether onboarding is complete,
> plus a migration. `PUT /api/account/preferences` and `GET`.
>
> Then `GET /api/recommendations` producing a real ranked list from the caller's
> preferred genres, library shelves, reading history and ratings, with a
> documented, deterministic scoring function in one place, and a sensible
> cold-start fallback to trending for a user with no signal. Rank in SQL where
> practical.
>
> FE: wire the onboarding flow to save and redirect, gate the flow on the
> `onboardingComplete` flag rather than local state so a refresh mid-flow behaves,
> and point `pages/HomePage.tsx` recommendation shelves at the real endpoint.
>
> Tests: cold-start returns trending rather than an empty list, preference
> changes visibly change the ranking, already-finished books are excluded.

---

## Task 17 — Retire the mock layer

Final cleanup. Do last.

**Half done already.** The story, chapter, book, shelf, comment, rating and
reading-history fixtures are gone from `mock-db.ts` (832 lines down to ~400),
along with the author aggregates that invented view series and read counts.
What remains is the data whose features have no endpoints: clubs, channels,
challenges, badges, and the author directory (`db.authors`) — plus `db.currentUser`,
which `AuthProvider` still uses for the presentational half of a session
(avatar hue, follower counts, reading stats) that `auth.User` has no columns
for. Each goes with its own task; this one is the final sweep.

**Prompt:**

> Once the other tasks have landed, remove the mock data layer entirely.
>
> Verify nothing imports `apps/web/src/data/api.ts` or `data/mock-db.ts`, then
> delete both. Reconcile `apps/web/src/types/domain.ts` (mock-shaped) with
> `types/books.ts` and the real API response types — ideally generate or share
> them from the API rather than maintaining two hand-written copies; if that is
> too large a change, say so and instead consolidate them into one file with a
> comment pointing at the API source of truth.
>
> Audit every page for loading, empty and error states now that latency is real
> and requests can fail — the mock's fixed 260ms `delay()` and
> never-fails behaviour hid all of it. Use the existing `components/ui/States.tsx`
> and `Skeleton.tsx`.
>
> Confirm the full test suite passes and the app builds.
