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
+ broadcast channels, comments + ratings, public profiles + follows, writing
challenges + leaderboard.

Tasks are numbered by when they were written down, not by when to do them. This
is the order to do them in, and the reason for each position.

| # | Task | Why here |
|---|---|---|
| 1 | **8** — author analytics | Introduces the view / chapter-read event log. Independent of everything above, but it must precede 12. |
| 2 | **12** — badges & levels | A pure consumer once 8 lands: streak and words written exist, comments and ratings come from 3, follows from 13, and "chapters read" is only countable from 8's event log — `ReadingHistory` keeps current position per story, not a count. Doing 12 before 8 means either inventing that metric or building it twice. |
| 3 | **14** — notifications | All four dependencies — 3, 9, 10, 13 — have landed, so every event it fans out from is real. Below 12 only because a newly earned badge is one of the five notification types. |
| 4 | **15** — moderation & reporting | The role it needs a moderator to be is now `auth.User.isAdmin`, landed with 11 and read only in `services/roles.ts`. The content to moderate is all there: 3's comments join 9's discussions and 10's posts. |
| 5 | **16** — onboarding preferences & recommendations | Scores over reading history (landed), library shelves (landed), ratings (landed with 3) and follows (landed with 13). Late because a recommender is worth building once there is signal to rank on. |
| 6 | **17** — retire the mock layer | Last by definition. |

**One shared decision, taken once — now settled.** Clubs' discussions,
channels' posts and stories' comments are three spellings of the same thing:
user-written text, paginated newest-first, with an author summary, a
rate-limited create and a delete only the author or an admin may perform. 9 got
there first, 10 followed it, and **3 followed it too** rather than inventing a
third. Concretely, as `services/clubs.ts`, `services/channels.ts` and
`services/engagement.ts` now spell it:

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

## Task 3 — Comments & ratings — **landed**

`services/engagement.ts` + `routes/engagement.ts`, mounted at `/api` rather
than under the stories router, because the resource set spans both
`/api/stories/:id/...` and `/api/comments/:id`; splitting that across two
routers would put one service behind two files. `app.ts` mounts it after the
stories router, which matches none of those paths.

Endpoints: `GET`/`POST /api/stories/:storyId/comments`, `DELETE
/api/comments/:id`, `PUT`/`DELETE /api/stories/:storyId/rating`, `GET
/api/stories/:storyId/ratings`.

**The decisions this task owned.**

- **`ratingCount` was added as a column**, and both it and `ratingAverage` are
  recomputed inside the same transaction as every rating write. They are *not*
  the read path — `services/stories.ts` still computes both from `Rating` rows
  and falls back to the column only when there are none — but `sort=rating`
  orders in SQL over the story table, so a stale column silently mis-sorts the
  catalogue. `ratingAverage` is set back to null, not 0, when the last rating
  goes.
- **Delete is the comment's author alone.** The shared shape says
  "author-or-moderator, resolved from the membership row", but a story has no
  membership table, so there is no moderator to resolve. The story's author is
  deliberately *not* given the power — that is a moderation rule, and Task 15
  owns the role decision that would justify it. A test pins this, so changing
  it is a deliberate act.
- **Comments carry `parentId`**, one level deep, with `createComment`
  re-pointing a reply-to-a-reply at its thread — the same table and the same
  rule as `clubs.ClubDiscussion`. A reply inherits its thread's `chapterId`
  rather than taking the caller's, so a reply cannot hide from the chapter
  panel its thread is showing in.
- **Comments are chapter-scopable.** `engagement.Comment.chapterId` already
  existed; the reader's panel filters on it, the story page's tab does not.

**What this removed rather than faked.** The rating dialog's "Review
(optional)" textarea is gone: `engagement.Rating` stores a score and no body,
so every word typed into it was discarded on save. Written reviews are a column
and a migration, not a UI change — the Reviews tab now says so. The
`RatingBars` chart is wired to the real breakdown and is no longer unused.

**Unseen in a browser:** a thread with its replies expanded on
`StoryDetailPage` at phone width; the reader's comment panel with enough
comments to scroll; and the Delete action, which reads `session.user.id` and so
is hidden in local development where `readerHeaders()` identifies the caller by
header instead — the same gap clubs and channels have.

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

## Task 11 — Writing challenges & leaderboard — **landed**

`services/challenges.ts` + `routes/challenges.ts` at `/api/challenges`, plus
`services/roles.ts`, which owns the admin flag this task was put first for.

Endpoints: `GET /api/challenges`, `GET /api/challenges/:slug`, `GET
/api/challenges/:slug/leaderboard`, `POST /api/challenges/:id/enter`,
`PUT`/`DELETE /api/challenges/entries/:id`, and `POST /api/challenges` /
`PATCH /api/challenges/:id` for administrators.

**The decisions this task owned.**

- **The role is one boolean, `auth.User.isAdmin`, read in exactly one place.**
  Not a `UserRole` enum: there is a single privileged set of actions today, so
  `MODERATOR` and `ADMIN` would be two names for the same permission with
  nothing enforcing the difference — and widening a boolean into an enum is a
  migration whenever they genuinely diverge. What Task 15 must not do is invent
  a *second* notion of staff; `assertAdmin` in `services/roles.ts` is the one
  to call. **Nothing grants the flag over HTTP** — `scripts/grant-admin.ts`
  sets it against the database, so no request can escalate itself and there is
  no endpoint to forget to protect.
- **State is derived, never stored.** `upcoming` / `active` / `past` are the
  three positions `now()` can hold against `startAt` and `endAt`. `stateOf` is
  the only place that is decided, and `assertOpen` asks it the same question
  the page displays, so "the badge says active" and "the API let me in" cannot
  come apart.
- **Entering and submitting are two steps**, so `ChallengeEntry.storyId` became
  nullable and the unique key went from `[challengeId, userId, storyId]` to
  `[challengeId, userId]` — the old one let one writer hold several rows on the
  leaderboard and made "already entered?" a question with no single answer.
  That split is also what makes the page's two stats mean different things:
  participants are entries, entries are entries with a story on them.
- **The ranking rule is `score = the sum of the star ratings the entry's story
  has earned`,** ranked in SQL, in one commented function (`RANKING` in
  `services/challenges.ts`). Summing rather than averaging is deliberate: a
  mean lets one five-star rating beat fifty fours, and the sum is monotone in
  both reach and quality without an invented Bayesian prior. Ties break by
  rating count, then earliest submission, then entry id — a total order, so
  paging a board cannot repeat or skip a row.
- **Only published entries are ranked, and the board is built anonymously.**
  `getStoriesByIds(…, null)` rather than as the caller: resolving as the viewer
  would put an author's own draft on the board for them alone and shift
  everybody below it by one. A writer who attached a draft is told so on the
  detail page instead.
- **Edits close with the challenge.** Swapping a story, editing a note and
  withdrawing all go through `assertOpen`, because a board that can still
  change after it closed is not a result. Entering out of window and entering
  twice are both 409 — nothing about the request is malformed, the challenge is
  just not in a state that accepts it.
- **A story must be the caller's own and `source = SCRIBE`.** Without the first
  check anybody could enter somebody else's story and take their ranking; the
  second is the filter `countVisibleStoriesBy` already applies, because a
  catalogue edition carries a real author column and nobody wrote it here.

**What this removed rather than faked.** The entry's `voteCount` and `rank` are
gone as stored fields: there is no ballot in the contract, and inventing a
voting feature to fill a mock column was the wrong place to start — the board
ranks on `engagement.Rating`, which is real, and the leaderboard row shows the
score with the rating count beside it rather than a heart. A challenge's `hue`
is derived from the slug through `hueFor`, the way a club's and a channel's
are. The **"Host a challenge" button is gone**: creating one is an admin action
and there is no admin surface in the reader-facing app to put it behind, so the
button promised something it could not do — the same call Task 15 makes about a
moderator UI. "Remind me when it opens" went with it, because there is nothing
to remind anybody with until Task 14.

**What was added because the UI genuinely collects it.** `WritingChallenge`
gained `slug`, `prompt`, `wordTarget` and `hostId`; `ChallengeEntry` gained
`note`, which the submit dialog was discarding on save — it round-trips now, so
the dialog re-opens on what was written rather than blank.

**Seeded rather than left empty.** The mock's challenge fixtures are deleted,
and nothing but an administrator can create a replacement, so
`scripts/seed-challenges.ts` (`pnpm --filter api seed:challenges`) loads six
challenges across the three states and moves their windows forward on every
run. It seeds no *entries*: a place belongs to a writer who took it, and the
board ranks on ratings readers left.

**Unseen in a browser:** the challenge hero and its derived banner hue at phone
width; the leaderboard rows with a long story title beside a long handle, where
`.leaderboard__story` has to clamp rather than push the score off the row; and
the enter → submit sequence, where two requests happen behind one button.

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

## Task 13 — Public profiles & follows — **landed**

`services/users.ts` + `routes/users.ts` at `/api/users`. Endpoints: `GET
/api/users/:username`, `/stories`, `/followers`, `/following`, and
`POST`/`DELETE /api/users/:username/follow`.

**The decisions this task owned.**

- **`engagement.Follow`, not `auth.Follow`.** `auth` describes who somebody
  *is*; the rest of `engagement` describes what readers *did*, and a follow is
  the same kind of row as a rating with another reader as its object. The pair
  is unique; **self-follow is refused in the service**, because the contract
  cannot express a check constraint — so the rule lives in exactly one place
  and a test pins it.
- **Counts are computed, never denormalised.** `Story.ratingAverage` is a
  column because `sort=rating` orders in SQL over the story table; nothing
  sorts or filters on a follower count, so a column would buy nothing and
  could only drift.
- **Both writes are idempotent and return the fresh state.** Following twice
  leaves one row; unfollowing a stranger is a no-op, not a 404. Both answer
  `{ following, followerCount }` so the button redraws without a second
  request — the same reasoning as `DELETE .../rating` returning the summary.
- **`storyCount` and the Stories tab share one rule.** `countVisibleStoriesBy`
  in `services/stories.ts` applies the same `visibleTo` *and* `source =
  SCRIBE` filters `listStories` does. The first draft of this got it wrong —
  the header said 4 over a tab listing 1, because seeded catalogue editions
  carry a real author — which is why the count is exported from the stories
  service rather than written a second time. A test pins it.
- **The profile shape is written out field by field**, sharing nothing with
  `services/account.ts` but the table. `email`, `emailVerified`, `hasPassword`,
  `googleId` and `streakLastReadAt` are never selected. A test asserts the
  exact key set, so a column added to `auth.User` cannot start leaking.
- **`auth.User.bio` already existed** (added with the settings task), so the
  profile renders it with no migration of its own.

**What this removed rather than faked.** The stat row was four mock aggregates;
it is now four real ones — stories, followers, following, reading streak.
`chaptersRead`, `minutesReadThisWeek` and `totalViews` are gone, because
nothing records a view or a chapter read yet: that is Task 8, and Task 12 owns
the levels the header now shows. The author's average-rating chip went with
them — per-story averages are real, an author-wide one is not an endpoint.

**A bug this fixed on the way.** `ProfilePage` rendered the *viewer's* library,
badges and clubs under whichever name was in the URL, so somebody else's
profile showed your own currently-reading shelf. Those four sections are now
gated on the profile being your own, and `/profile/<your own handle>` counts as
your own too — the page folds `!routeUsername` and the API's `isMe` into one
flag, so the two routes to it cannot behave differently.

**Still mock-fed:** the Badges tab, which is the caller's own and Task 12's to
replace (`GET /api/users/:username/badges` is in that task). `db.authors`
survives for `OnboardingPage`'s author picker — Task 16 owns that flow, and
retiring the fixture with it.

**Unseen in a browser:** the follower/following grid at phone width; the
optimistic Follow button under a failing request, where the roll-back and the
error toast have only been reasoned about; and the header actions on
`/profile/<your own handle>`, which read the API's `isMe` and so answer for
whoever the *dev header* names in local development — the same gap clubs,
channels and comments have.

## Task 14 — Notifications

Depends on Tasks 3, 9, 10, 13 — **all four have landed**, so every event it
fans out from is real: a new club discussion, a new channel post, a new story
comment, and now "a new story by an author you follow", which
`engagement.Follow` is what makes addressable. `clubs.ClubDiscussion.parentId`
and `engagement.Comment.parentId` are what make "a reply to your comment"
expressible for club threads and for story comments respectively.

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

Depends on Tasks 3 and 9, **both landed**, so comments, club discussions and
channel posts all exist as user-generated content with no reporting path. Their
public read paths are `listComments` in `services/engagement.ts`,
`listDiscussions` in `services/clubs.ts` and `listPosts` in
`services/channels.ts` — all three need auditing for hidden content when this
lands. `services/engagement.ts` is also where the story-author-as-moderator
question was deferred to; answering it is what is left of this task's role
decision, because the role itself landed with 11 as `auth.User.isAdmin`.

**Prompt:**

> Comments, club discussions and channel posts are all user-generated with no
> reporting or moderation path.
>
> Add a `Report` model (reporter, target type, target id, reason, status,
> resolvedBy, timestamps) plus a migration, and `POST /api/reports` (rate-limited,
> one open report per user per target). Add a moderator view: `GET
> /api/moderation/reports` with filters and `POST /api/moderation/reports/:id/resolve`
> taking an action (dismiss, hide content, suspend user). The role already
> exists — `auth.User.isAdmin`, landed with Task 11 and read only through
> `assertAdmin` in `services/roles.ts`. Call that; do not invent a second
> notion of staff. Splitting it into a `MODERATOR` / `ADMIN` distinction is
> fair game *if* the two get genuinely different powers here — say which, and
> migrate.
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
reading-history, club, channel and challenge fixtures are gone from
`mock-db.ts` (832 lines down to ~177), along with the author aggregates that
invented view series and read counts. `data/api.ts` is down to two functions.
What remains is the data whose features have no endpoints: badges, and the
author directory (`db.authors`) — plus `db.currentUser`, which `AuthProvider`
still uses for the presentational half of a session (avatar hue, follower
counts, reading stats) that `auth.User` has no columns for. Each goes with its
own task; this one is the final sweep.

Two of those now have a real replacement to point at rather than a missing
endpoint. `db.authors` survives only for `OnboardingPage`'s author picker:
`GET /api/users/:username` serves a profile and follows are real, so what that
step still lacks is somewhere to *persist* its answers — Task 16. And the
session's `followerCount` / `followingCount` are now computable, so
`AuthProvider.toUser` no longer needs the mock for them; `ProfilePage` already
bypasses it and asks the API for its own numbers.

The club, channel and challenge types also left `types/domain.ts` for
`types/clubs.ts`, `types/channels.ts` and `types/challenges.ts`, which mirror
the API the way `types/stories.ts` does. That is the pattern this task's
reconciliation should finish, not undo.

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

### Public profiles and follows (Task 13)

- **The optimistic Follow button has never failed.** The flip, the count
  adjustment and the roll-back on an `ApiError` are straightforward, but only
  the happy path has been exercised — a rejected follow's toast and the
  restored count want a throttled or offline browser to see.
- **`isMe` has two sources that can disagree in development.** The page treats
  a profile as its own when the route carries no handle *or* when the API says
  `isMe`, and the API answers for whoever `readerHeaders()` names when there is
  no session. So a dev without a real session sees "Edit profile" on the dev
  user's profile and a Follow button on their *own* account's. Goes away with
  the dev header, like the same gap in clubs, channels and comments.
- **Followers pages are offset-based**, so a follow arriving mid-scroll can
  shift a row across a page boundary. `createdAt` + `id` makes the *order*
  stable, not the offsets; a keyset cursor is the fix if these lists ever get
  long enough to matter.
- **Nobody can see another reader's badges, clubs or shelves.** Those four
  tabs are gated on the profile being the caller's own, which is honest today —
  there is no endpoint that answers them for somebody else. Task 12 adds the
  badge one; a public "clubs this person is in" would be a new endpoint on the
  clubs service, not a UI change.
- **Unseen in a browser:** the follower/following grid at phone width, where
  `.people-list` drops to one column and a long display name has to clamp
  rather than push the "Following" badge off the row.

### Writing challenges (Task 11)

- **The window is judged by the app's clock, not the database's.** `stateOf`
  and `assertOpen` compare `new Date()` against the stored window, while every
  other timestamp on the row is written by Postgres. The two agree to within
  clock skew, and a challenge closing in the second that separates them is the
  same class of gap the streak's untested midnight is. Comparing in SQL would
  close it, at the cost of a round trip on every read.
- **"Entries" and the board's total can legitimately disagree.** The stat tile
  counts places with a story attached; the leaderboard ranks only *published*
  ones. A writer who attached a draft is counted above and absent below, which
  the detail page tells them in as many words — but somebody reading the two
  numbers side by side has no way to know that is why.
- **The leaderboard is offset-paged**, so a rating arriving mid-scroll can move
  a row across a page boundary. `ROW_NUMBER()` over a total order makes the
  *ranking* stable, not the offsets; a keyset cursor is the fix if a board ever
  gets long enough to matter. The same caveat the followers lists carry.
- **There is no host UI at all.** `POST` / `PATCH /api/challenges` are covered
  by tests and reachable with a token, but the only supported way to make an
  administrator is `pnpm --filter api admin:grant`, and the only way to create
  a challenge outside the seed script is the API directly. Deliberate — an
  admin console is its own surface — but it means the create and edit paths
  have never been exercised by a person.
- **Withdrawing is impossible once a challenge closes.** Deliberate: a closed
  board is a result, and a row leaving it would renumber everybody below.
  Nothing yet offers the other thing a writer might want — removing an entry
  from a finished board — which is Task 15's territory rather than a fourth
  state here.
- **Dev identity:** the entry the detail page shows is the caller's, and with
  no session the API answers for whoever `readerHeaders()` names. So a dev
  without a real session sees the dev user's entry and can withdraw it — the
  same gap clubs, channels, comments and profiles have, and it goes with the
  dev header.
- **Unseen in a browser:** the challenge hero and its derived banner hue at
  phone width; a leaderboard row with a long story title next to a long handle,
  where `.leaderboard__story` has to clamp rather than push the score off the
  row; and the enter → submit sequence, where one button fires two requests and
  the dialog opens on the second.

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
