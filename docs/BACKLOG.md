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

## Order

**Landed:** auth + account, books + library, stories/chapters + the reader,
authoring, uploads + chapter multimedia, reading progress + streak, book clubs
+ broadcast channels.

Tasks are numbered by when they were written down, not by when to do them. This
is the order to do them in, and the reason for each position.

| # | Task | Why here |
|---|---|---|
| 1 | **3** — comments & ratings | The only remaining task that unblocks others (14, 15). Purely additive on the FE. Reuse the thread shape 9 established for `ClubDiscussion` rather than inventing a second one — see the note below. |
| 2 | **13** — public profiles & follows | With 3 done this closes all four of 14's dependencies. Also the payoff for the author summaries clubs, channels and comments all render: `/profile/:username` is a live route in `App.tsx` with no endpoint behind it. |
| 3 | **11** — challenges & leaderboard | Owns the admin/moderator role decision. 15 reuses it, so this comes first. |
| 4 | **8** — author analytics | Introduces the view / chapter-read event log. Independent of everything above, but it must precede 12. |
| 5 | **12** — badges & levels | A pure consumer once 8 lands: streak and words written exist, comments and ratings come from 3, and "chapters read" is only countable from 8's event log — `ReadingHistory` keeps current position per story, not a count. Doing 12 before 8 means either inventing that metric or building it twice. |
| 6 | **14** — notifications | Needs 3, 9, 10, 13 — 9 and 10 have landed. |
| 7 | **15** — moderation & reporting | Needs 3 for content to moderate (9's discussions are already there), and 11's role for a moderator to be. |
| 8 | **16** — onboarding preferences & recommendations | Scores over reading history (landed), library shelves (landed) and ratings (3). Late because a recommender is worth building once there is signal to rank on. |
| 9 | **17** — retire the mock layer | Last by definition. |

**One shared decision, taken once — now settled.** Clubs' discussions,
channels' posts and stories' comments are three spellings of the same thing:
user-written text, paginated newest-first, with an author summary, a
rate-limited create and a delete only the author or an admin may perform. 9 got
there first and 10 followed it, so **Task 3 follows the same shape** rather than
inventing a third. Concretely, as `services/clubs.ts` and `services/channels.ts`
now spell it:

- A `Page<T>` of `{ items, page, limit, total, totalPages, hasMore }`, newest
  first with `id` as the tie-breaker so pagination cannot repeat a row.
- An author summary of exactly `{ id, username, displayName, avatarUrl }` —
  never the whole user row.
- One table for threads and replies, a nullable `parentId` telling them apart,
  replies capped at one level deep (`createDiscussion` re-points a reply to a
  reply at its thread), and `replyCount` gathered for a whole page in one query.
- Create is rate-limited per *user*, not per IP, and charged only after the
  write succeeds; delete is author-or-moderator, resolved from the membership
  row rather than a creator column.

Three independent implementations is still the outcome worth avoiding — 15 would
then have three different read paths to audit for hidden content, and that is
exactly where a moderation bug hides.

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
authoritative is part of this task.

The mock comment and rating functions are **already gone** from `data/api.ts` —
there is nothing to unwire. `StoryDetailPage` simply renders no comments, the
reader's comment panel says "Comments are not available yet" in so many words,
and `components/charts/RatingBars.tsx` is imported nowhere. So this task is
purely additive on the frontend.

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
> FE — a new `data/engagement-api.ts`; there are no mock functions left to
> replace. Wire `pages/StoryDetailPage.tsx` and the currently-unused
> `components/charts/RatingBars.tsx` to the real breakdown,
> `components/ui/Rating.tsx` to submit, and replace the reader's
> "Comments are not available yet" panel with the real thread.
>
> Tests: comment validation and ownership on delete, rating upsert replaces
> rather than duplicates, denormalised average matches a recomputed one after a
> series of writes.

---

## Task 8 — Author analytics

Depends on the authoring task, which has landed.

`getAuthorOverview` is **already gone** from `data/api.ts`, along with the view
series and read counts it invented, so both pages currently show what the real
`content.Story` columns carry and nothing more. The task is to record the events
that would make a series real, not to replace a fake one.

**Prompt:**

> `apps/web/src/pages/author/AuthorAnalyticsPage.tsx` and
> `AuthorDashboardPage.tsx` want views, reads, average rating, engagement and a
> time series. Nothing records any of it: there is no view event and no
> chapter-read event anywhere in the contract.
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
> a series, so match its shape.
>
> Tests: dedupe within a day, range boundary correctness, and that a story with
> no events returns zeroes rather than erroring or omitting days.

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

Depends on Tasks 3, 9, 10, 13. **9 and 10 have landed**, so a new club
discussion and a new channel post are both real events to fan out from now;
`clubs.ClubDiscussion.parentId` is what makes "a reply to your comment"
expressible for club threads.

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

Depends on Tasks 3 and 9. **9 and 10 have landed**, so club discussions and
channel posts already exist as user-generated content with no reporting path —
their public read paths are `listDiscussions` in `services/clubs.ts` and
`listPosts` in `services/channels.ts`, and both need auditing for hidden
content when this lands.

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

**Mostly done already.** The story, chapter, book, shelf, comment, rating,
reading-history, club and channel fixtures are gone from `mock-db.ts` (832
lines down to ~263), along with the author aggregates that invented view series
and read counts. `data/api.ts` is down to four functions. What remains is the
data whose features have no endpoints: challenges, badges, and the author
directory (`db.authors`) — plus `db.currentUser`, which `AuthProvider` still
uses for the presentational half of a session (avatar hue, follower counts,
reading stats) that `auth.User` has no columns for. Each goes with its own
task; this one is the final sweep.

The club and channel types also left `types/domain.ts` for `types/clubs.ts` and
`types/channels.ts`, which mirror the API the way `types/stories.ts` does. That
is the pattern this task's reconciliation should finish, not undo.

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

---

## Open questions from landed work

Things the test suite cannot reach — browser behaviour, real clocks, layout.
Each is a known gap, not a suspicion: worth confirming by hand, and worth
folding into whichever task next touches that surface.

### Reading progress (Task 2)

- **A late-growing chapter restores short.** The restore measures
  `document.body.scrollHeight` in one `requestAnimationFrame` after the chapter
  paints (`hooks/useReadingProgress.ts`). A chapter carrying an image or video
  whose intrinsic size arrives after that frame grows the page *after* it was
  measured, so the reader lands earlier than where they stopped. Text-only
  chapters are unaffected. The fix is to re-apply the restore when the article
  resizes (a `ResizeObserver`, or a second pass on media `load`) — deliberately
  not done, because it wants a browser to tune against.
- **The offset↔scroll mapping assumes even text density.** A character offset is
  converted to a scroll position by simple proportion, which is exact for prose
  and drifts in proportion to how much vertical space a chapter's attachments
  take, since no characters correspond to them. Restoring *within* a chapter is
  approximate for media-heavy chapters; the chapter itself is always right.
- **The streak has never crossed a real midnight.** `advanceStreak` is unit
  tested against a controlled clock for every branch, but the wiring has only
  been exercised against a backdated anchor (`TestApi.setStreak`), never against
  the database's own `now()` rolling over a UTC day.
- **Catalogue books record no position.** `PUT /api/reading/progress` requires a
  `chapterId`, and catalogue editions are `Story` rows with no chapters, so the
  Reading shelf and the "Pick up where you left off" rail can legitimately
  disagree about what is in progress. Intended for now; revisit if the reader
  ever opens a catalogue edition.
- **`useReadingProgress` stops saving for the rest of the page load** once the
  API answers 401/403, so a reader who signs in while the reader page is open
  saves nothing until they navigate. Cheap to fix by keying the block on the
  session rather than the mount.
- **Unseen in a browser:** the "Pick up where you left off" rail — `ContinueCard`
  inside `card-grid--wide` — at phone width, and the restore/save cycle while
  flicking quickly between chapters.
- **Dev identity:** saves go out with `stories-api.ts`'s `readerHeaders()` when
  no session exists, so `VITE_DEV_USER_ID` has to name a user that really
  exists. If it does not, every save 401s and the block above silences it for
  the whole page load with nothing shown to the reader.

### Clubs and channels (Tasks 9 and 10)

- **What the mock invented, and what replaced it.** Five fields had nothing
  behind them and were dropped rather than faked: a club's `isPrivate` (there is
  no invite or approval flow — every club is open, and the detail page now says
  "Open club" unconditionally), its `genreIds` (clubs have no genre relation),
  and a channel post's `likeCount`, `commentCount` and `linkedStoryId` (a
  channel is one-way; `.post__foot` and `.post__link` left `pages.css` with the
  markup). A club's and a channel's `hue` is now derived from the slug through
  `hueFor` rather than stored, which is what it always was. Two columns were
  *added* because the UI genuinely collects them: `BookClub.slug` /
  `currentStoryId` and `BroadcastChannel.slug` / `ChannelPost.title`.
- **`ClubDiscussion` has no title.** The mock carried a separate title and body;
  the contract carries one `body`, so the thread list clamps the body to two
  lines as its headline (`.thread__title`). If threads ever want real titles
  that is a column and a migration, not a UI change.
- **A club's discussion rail on `ClubsPage` is one request per club**, capped at
  the first four on screen. There is no cross-club discussion feed endpoint, and
  inventing one for a sidebar was the wrong place to start — but it is the first
  thing to replace if that rail stays.
- **`members` and `subscribers` sorts page in JS.** Both counts live in a child
  table and the ORM's grouped collection cannot order by an aggregate, so those
  two sorts hydrate the whole filtered set and slice it. Fine at today's row
  counts, wrong at ten thousand clubs; the fix is `db.sql` with a join, and the
  comment in `listClubs` says so.
- **Ownership transfer is two steps, deliberately.** `PATCH
  /:id/members/:userId` to make somebody else `OWNER`, then leave. The last
  owner cannot leave or be demoted (409), and `assertNotLastOwner` runs inside
  the same transaction as the write it guards. There is no one-shot "transfer
  ownership" endpoint; if the UI wants one, it is a wrapper, not a new rule.
- **Delete actions are hidden rather than disabled** when the caller is neither
  the author nor a moderator, and that check reads `session.user.id` — which is
  null in local development, where `readerHeaders()` identifies the caller by
  header instead. So a dev without a real session sees no Delete button on their
  own posts even though the API would allow it. Cheap to fix once the dev header
  goes.
- **Unseen in a browser:** the club hero and its derived banner hue at phone
  width; a thread with its replies expanded inside `.discussion-replies`; the
  channel feed's "Load older posts" accumulation across more than two pages; and
  `AuthorChannelsPage` with more than one channel, where the channel picker row
  appears.
