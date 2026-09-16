# Scribe — Implementation Backlog

What is left to build, and in what order. Derived from the gap between the
frontend surface (`apps/web/src/pages`) and the API (`apps/api/src/routes`).
Most of that gap is closed; `data/api.ts` is down to one mock function, and
Task 17 is the sweep that removes it.

**Landed tasks are not kept here.** Each one's decisions live in the header of
the service that owns them — that is the file somebody changing the behaviour
has open, and a second copy in this document could only go stale. What *is*
kept is the list below, so a task can name its dependencies, and the open
questions at the end, which are outstanding rather than done.

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

### Landed

| Feature | Where its decisions are written down |
|---|---|
| Auth, sessions, Google sign-in | `services/passwords.ts`, `routes/auth.ts`, `lib/jwt.ts` |
| Account + avatar uploads | `services/account.ts`, `services/uploads.ts` |
| Catalogue books + My Library | `services/books.ts`, `services/library.ts` |
| Stories, chapters, the reader | `services/stories.ts` |
| Authoring + chapter multimedia | `services/authoring.ts` |
| Reading progress + streak | `services/reading.ts` |
| Book clubs, broadcast channels | `services/clubs.ts`, `services/channels.ts` |
| Comments + ratings (Task 3) | `services/engagement.ts` |
| Public profiles + follows (Task 13) | `services/users.ts` |
| Writing challenges + leaderboard (Task 11) | `services/challenges.ts`, `services/roles.ts` |
| Author analytics (Task 8) | `services/analytics.ts`, `engagement.StoryView` in `contract.prisma` |
| Badges & levels (Task 12) | `services/gamification.ts`, `gamification.UserBadge` in `contract.prisma` |

### What is left

Tasks are numbered by when they were written down, not by when to do them. This
is the order to do them in, and the reason for each position.

| # | Task | Why here |
|---|---|---|
| 1 | **14** — notifications | All four dependencies — 3, 9, 10, 13 — have landed, so every event it fans out from is real, and 12 has now landed too: "a badge earned" is one of its five notification types, and the browser-local `newlyEarnedSince` in `data/gamification-api.ts` is the placeholder it replaces. |
| 2 | **15** — moderation & reporting | The role it needs a moderator to be is now `auth.User.isAdmin`, landed with 11 and read only in `services/roles.ts`. The content to moderate is all there: 3's comments join 9's discussions and 10's posts. |
| 3 | **16** — onboarding preferences & recommendations | Scores over reading history (landed), library shelves (landed), ratings (landed with 3) and follows (landed with 13). Late because a recommender is worth building once there is signal to rank on. |
| 4 | **17** — retire the mock layer | Last by definition. |

### One shared shape, settled

Clubs' discussions, channels' posts and stories' comments are three spellings
of the same thing: user-written text, paginated newest-first, with an author
summary, a rate-limited create and a delete only the author or an admin may
perform. 9 got there first, 10 followed it, and **3 followed it too** rather
than inventing a third. Concretely, as `services/clubs.ts`,
`services/channels.ts` and `services/engagement.ts` now spell it:

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
invented view series and read counts — and those now have a real replacement to
point at rather than a missing endpoint, since Task 8 landed `GET
/api/author/analytics`. `data/api.ts` is down to two functions.
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

The club, channel, challenge and badge types also left `types/domain.ts` for
`types/clubs.ts`, `types/channels.ts`, `types/challenges.ts` and
`types/gamification.ts`, which mirror the API the way `types/stories.ts` does. That is the pattern this task's
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

### Author analytics (Task 8)

- **The visitor digest's day and the row's day are decided by different
  clocks.** `visitorFor` salts with this process's UTC day; the `day` column is
  written by `to_char(now() AT TIME ZONE 'UTC', …)` in the same statement. In
  the second the two disagree a signed-out visitor can land twice, once either
  side of midnight — one extra view per visitor per year. Closing it means
  computing the digest in SQL, which is not something SQL should be doing.
- **`Story.viewCount` mixes a seeded base with real events.** Every value in
  the column today came from `seed-books.ts` / `seed-stories.ts`; every
  increment from here is a deduped view. So "all time" on the author pages is
  honest about the platform and not about the story, and a 30-day figure far
  below it is expected rather than a bug. The seeds are the thing to change if
  that ever matters.
- **An anonymous visitor is one visitor per address *and* user agent.** Two
  people behind one NAT with different browsers are two; the same person on two
  browsers is also two. The usual trade, but it means `readers` is an estimate
  for signed-out traffic and exact for signed-in.
- **Nothing counts a view of a chapter the reader deep-linked into.** Opening
  `/read/:slug/:n` directly records a chapter read and no story view, because
  the story endpoint was never called. The reader page happens to fetch the
  story for its header today, so this is currently theoretical — but it is a
  property of the page, not of the API.
- **`req.ip` is only as good as `TRUST_PROXY`.** Unset behind a real proxy,
  every signed-out reader shares the proxy's address and therefore one visitor
  key, and a day's anonymous views for a story collapse to one. The same
  configuration note the auth rate limits carry, with a quieter failure.
- **The event tables only ever grow.** Nothing prunes them and nothing rolls
  them up; at 90 days the queries stay indexed, but there is no retention
  policy and no monthly aggregate table. The first thing to add if a board ever
  needs a year.
- **Unseen in a browser:** the `LineChart` under a real 90-day series at phone
  width; the story picker with enough stories to make the select long; and the
  chapter breakdown for a story with thirty chapters.

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
- **Nobody can see another reader's clubs or shelves.** Those tabs are gated
  on the profile being the caller's own, which is honest today — there is no
  endpoint that answers them for somebody else. A public "clubs this person is
  in" would be a new endpoint on the clubs service, not a UI change. Badges
  used to be gated the same way and no longer are: Task 12 landed
  `GET /api/users/:username/badges`.
- **Unseen in a browser:** the follower/following grid at phone width, where
  `.people-list` drops to one column and a long display name has to clamp
  rather than push the "Following" badge off the row.

### Badges and levels (Task 12)

- **A newly earned badge is announced by the browser, not by the server.**
  A badge is awarded by whichever event moved its metric, and the reader is
  somewhere else when that happens. Until Task 14 there is nowhere to deliver
  that, so `newlyEarnedSince` in `data/gamification-api.ts` keeps the codes it
  has already shown in `localStorage` and toasts the difference the next time
  the badges page loads. Per browser, per account: a second device
  announces the same badge again, and a cleared store swallows one toast. The
  award itself is never at risk — only the telling.
- **`streakDays` is the current streak, not the longest.** Nothing stores a
  longest, so "read 30 days in a row" is only earnable while the run is still
  alive: a reader who managed 40 days last year and evaluates today at 3 does
  not get it retroactively. Once earned it is kept, because `UserBadge` is a
  record of the award and not of the metric. A `longestStreak` column on
  `auth.User` is the fix, and it is a migration rather than a rule change.
- **`storyViews` inherits the seeds' dishonesty.** It sums
  `content.Story.viewCount`, which the analytics work already documents as a
  seeded base plus real events — so a seeded author can hold *Popular Writer*
  for traffic nobody generated. The seeds are the thing to change, and the
  same note in the analytics section is where it is written down.
- **Evaluation runs on every debounced scroll save.** `recordProgress` calls
  `evaluateBadges`, which costs two reads (the metrics aggregate and the held
  codes) and writes nothing in the steady state. Cheap today and the wrong
  shape at scale: the fix is to evaluate on a boundary the reader crosses --
  a chapter finished rather than a scroll -- or to debounce per user in the
  service.
- **A fire-and-forget write has to be drained before anything deletes its
  subject.** An evaluation issued by a comment can still be about to insert a
  `UserBadge` row when `deleteAccount` sweeps that table, and a row landing
  between the sweep and the `auth.User` delete fails the whole deletion on
  `userBadge_userId_fkey`. `deleteAccount` calls `flushBadges()` before it
  opens the transaction, the server drains on `SIGTERM`, and `TestApi.cleanup`
  drains before teardown. The same reasoning applies to every future
  fire-and-forget writer, and the analytics tables have always had the shape
  without anybody drawing the line.
- **Nothing tells a reader their level went up.** The two ladders are visible
  on the badges page and the level number on the profile header, but crossing
  a step is silent. It is the same gap the badge toast fills and the same
  place Task 14 closes it.
- **The toast only fires on `/badges`.** `ProfilePage`'s badges tab reads the
  same list and does not diff it, so a reader who never opens the badges page
  is never told. Deliberate — one announcement point is easier to replace than
  two — but it is the reason the page is the only place a badge "arrives".
- **Unseen in a browser:** the three-meter row on `BadgesPage` at phone width,
  where `.badges__meters` drops to one column; the badges tab on somebody
  else's profile with nothing earned; and the toast itself, which has never
  fired outside a fresh `localStorage`.

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
