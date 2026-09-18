# Scribe — Implementation Backlog

What is left to build, and in what order. Derived from the gap between the
frontend surface (`apps/web/src/pages`) and the API (`apps/api/src/routes`).
That gap is now closed: `data/api.ts` has no mock functions left, only the
`db.currentUser` re-export `AuthProvider` still leans on, and Task 17 is the
sweep that removes it.

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
| Notifications (Task 14) | `services/notifications.ts`, `notifications.Notification` in `contract.prisma` |
| Moderation & reporting (Task 15) | `services/moderation.ts`, `services/roles.ts`, `moderation.Report` in `contract.prisma` |
| Preferences & recommendations (Task 16) | `services/preferences.ts`, `services/recommendations.ts`, `auth.UserPreference` in `contract.prisma` |

### What is left

One task, and it was always going to be the last one: nothing else can be
removed from the mock layer until everything that read it has somewhere else to
read from.

| # | Task | Why here |
|---|---|---|
| 1 | **17** — retire the mock layer | Last by definition, and now the only one left. |

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

Three independent implementations was the outcome worth avoiding, and 15 is
where that paid: hiding content had one filter to add per surface rather than
three shapes to reason about, and the audit list in the header of
`services/moderation.ts` is eleven lines rather than a research project. The
next surface that takes user-written text follows the same shape and adds one
line to that list.

---

## Task 17 — Retire the mock layer

Final cleanup. Do last.

**Almost done already.** Everything with an endpoint has left `mock-db.ts`:
the story, chapter, book, shelf, comment, rating, reading-history, club,
channel, challenge and badge fixtures, the author aggregates that invented
view series and read counts, the hand-written genre list, and — with Task 16 —
the author directory, whose one consumer now reads
`GET /api/recommendations/authors`. The file is 832 lines down to ~53 and
`data/api.ts` has no functions left at all.

What survives is exactly one object. `db.currentUser` fills the presentational
half of a session — avatar hue, follower and following counts, reading stats —
that `auth.User` has no columns for, and `AuthProvider.toUser` spreads it under
the real profile so those fields have *something*. Every page that shows a real
number already bypasses it: `ProfilePage` asks the API for its own counts,
`BadgesPage` for its own progress, the author pages for their own analytics. So
this is a `User` type to narrow rather than an endpoint to wait for.

The club, channel, challenge, badge, moderation, preference and recommendation
types also left `types/domain.ts` for `types/clubs.ts`, `types/channels.ts`,
`types/challenges.ts`, `types/gamification.ts`, `types/moderation.ts`,
`types/preferences.ts` and `types/recommendations.ts`, which mirror the API the
way `types/stories.ts` does. That is the pattern this task's reconciliation
should finish, not undo.

**Prompt:**

> Every other task has landed. Remove the mock data layer entirely.
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

### Notifications (Task 14)

- **The bell polls, so a notification is up to a minute late.** Deliberate, and
  the whole of what makes it a poll is `subscribe` in
  `hooks/useNotifications.ts` — handed a callback, returns a teardown, which is
  the contract an `EventSource` or a websocket already has. Replacing the
  transport is rewriting that function; the reconciling around it already
  assumes rows can arrive at any moment. What has not been proved is the
  reconnect behaviour a push transport needs and a poll does not have.
- **There is no notifications *page*.** The dropdown holds the newest twelve
  and there is no "see all", so a reader who ignores the bell for a week loses
  the tail of it. `GET /api/notifications` is already paginated, so this is a
  route and a list component and no API work at all.
- **~~There is no way to turn any of it off.~~** Closed by Task 16, which
  built `auth.NotificationMute` beside the genre preferences rather than a
  second settings model, and put the filter in the fan-out: a muted type is
  never written, so nothing is stored that nobody asked for. What is left of
  the gap is that a mute is not retroactive, and that the enforcement is a
  clause five statements each have to carry — a sixth resolver that forgets it
  is a type nobody can turn off.
- **A club thread is one row per member, written at post time.** One statement,
  but a club of ten thousand members is ten thousand rows for every thread, and
  nothing digests or batches them. The fix when it matters is a fan-out-on-read
  for large audiences — keeping the event once and joining membership at query
  time — which is a different table, not a tuning knob on this one.
- **Somebody who joins after the fact hears nothing.** Fan-out is at write
  time, so subscribing to a channel today shows none of yesterday's posts.
  Correct rather than a gap, but it is the property that makes the row count
  above unavoidable.
- **The excerpt is frozen and the actor is not.** A renamed channel keeps its
  old name in notifications already sent, because `title` and `excerpt` are
  copies taken at fan-out time — a record of the moment, deliberately. The
  actor is a foreign key and so always current. The consequence — hiding a
  comment does not hide the copy of it sitting in somebody's bell — is answered
  by Task 15, which added `sourceType` / `sourceId` to the row and deletes the
  copies when the thing they quote is hidden. Rows written before that
  migration carry null and cannot be found, which is the one case still open.
- **`total` and `unreadCount` are two statements, not one snapshot.** A
  notification landing between them can make a page's arithmetic momentarily
  inconsistent — nineteen items on a page of twenty, say, with the count
  claiming twenty-one. Self-correcting on the next read, and closing it means
  one query computing both.
- **Nothing prunes the table.** The same note the analytics event tables carry,
  and for the same reason: a row per recipient per event only ever grows, and
  there is no retention policy. Read notifications older than some horizon are
  the obvious first thing to drop, since nothing reads them.
- **The drain order is load-bearing and only a comment enforces it.** A badge
  award issues a notification as it lands, so `flushBadges()` must settle
  before `flushNotifications()` starts — draining the two in parallel loses the
  badge notification about one time in ten. Every call site awaits them in
  order and says why, but nothing in the types stops the next one getting it
  wrong.
- **Dev identity:** the bell shows whoever `readerHeaders()` names when there
  is no session, so a dev without one sees the dev user's notifications. The
  same gap clubs, channels, comments, profiles and challenges have, and it goes
  with the dev header.
- **Unseen in a browser:** the dropdown at phone width, where it is pinned to
  `min(22rem, 100vw - 1.5rem)`; the `9+` badge on the bell; the optimistic
  mark-read rollback, which has only ever been exercised on the happy path; and
  a notification whose actor deleted their account, which should keep its text
  and lose the face beside it.

### Preferences and recommendations (Task 16)

- **The scoring weights have never been tuned against real behaviour.** Every
  number in `WEIGHTS` is a judgement — an explicitly chosen genre is worth more
  than everything else combined, popularity is worth almost nothing — and the
  tests pin the *ordering those weights produce*, not the weights. Nothing
  measures whether a reader clicks what the ranker put first, because nothing
  records a click on a recommendation. The first thing to add before touching a
  weight is that event.
- **The ranking is a full scan of every listed Scribe story.** One statement,
  correctly indexed on nothing in particular: `candidate` filters on `source`
  and `listedAt`, and the per-story genre and taste sub-selects run for each
  survivor. Fine at today's row counts and the wrong shape at a hundred
  thousand stories, where the answer is a materialised candidate set or a
  precomputed per-reader list refreshed on a schedule — not a faster query.
- **A story is excluded the moment a reader *opens* it.** The "already met"
  filter is any library row, any reading-history row or any rating, and reading
  history is written on the first debounced scroll. So a story somebody opened
  and abandoned after a paragraph never comes back, which is the same rule as
  finishing it. Distinguishing the two means reading `progress`, and the
  threshold would be a guess.
- **Catalogue editions are never recommended, only listened to.** The same rule
  `getRelatedStories` states, and it means the home page's personalised rail and
  its catalogue rails answer different questions from the same shelf data. A
  reader whose library is entirely imported books gets recommendations that
  share their genres and none of their format. Whether that is right is a
  product question nobody has asked yet.
- **`POST /api/library` cannot shelve a Scribe story.** Not this task's code,
  but this task is where it showed up: `addToLibrary` accepts any `Story` id,
  writes the row, and then 404s hydrating the response through `getBook`, which
  is catalogue-only. The caller is told it failed and the row is there. So the
  "already finished" exclusion reaches a *story* through reading history and a
  *book* through the shelf, and `routes/recommendations.test.ts` says so where
  it tests both.
- **Author suggestions rank by matching stories, not by matching well.** An
  author with one story in a preferred genre outranks one with nine, because
  the ordering is `matches DESC` and a tie falls to follower count. Worth a
  ratio rather than a count the day anybody has more than a handful of stories.
- **Onboarding saves per step, so a half-finished flow leaves half a row.**
  Deliberate — it is what makes a refresh resume — but it means a reader who
  quits at the author step has genres saved and `onboardingCompletedAt` null,
  and is put back at step *one* rather than where they stopped. Storing the
  furthest step reached would fix it, and it is a column rather than a rule.
- **Every existing account is sent through onboarding once.** Nobody has a
  preference row, and an absent row means "never asked" — which is the honest
  reading and also a one-time interruption for every reader who signed up
  before this landed. The alternative was backfilling a completed row for the
  whole userbase, which would have been a lie about all of them rather than an
  inconvenience to all of them.
- **A mute is not retroactive.** Turning a type off stops the fan-out writing
  new rows and leaves everything already in the bell. Correct, and the opposite
  of what `hideContent` does to the copies of hidden content — worth knowing
  they differ.
- **Unseen in a browser:** the recommendation rail's reason line under a card
  at phone width, where `.shelf__reason` has to clamp rather than wrap; the
  onboarding author step with no suggestions at all, which only happens on a
  database with no published Scribe stories; and the settings genre chips
  saving one at a time on a throttled connection, where `aria-busy` is the only
  feedback a click gets.

### Moderation and reporting (Task 15)

- **There is no moderator UI.** `GET /api/moderation/reports` and the resolve
  endpoint are covered by tests and reachable with a token, and the only way to
  make an administrator is still `pnpm --filter api admin:grant`. So the queue
  has never been read by a person, and the filters, the target excerpts and the
  "content no longer exists" case have only ever been exercised by assertions.
  The same deliberate gap the challenge host UI has, and the same argument: an
  admin console is its own surface.
- **Nobody is told their content was hidden.** The author of a hidden comment
  sees it vanish from the list and gets no notification, no banner and no
  reason; `AuthorChannelsPage` simply stops showing a hidden post, and
  `ownedPost` then 404s an edit of it. That is a deliberate omission rather
  than an oversight — a sixth `NotificationType` and a wording decision about
  how much of the reason to reveal — but it is the thing a moderated writer
  will ask about first.
- **Nor is the reporter.** A report is filed and the reader hears nothing more,
  whichever way it went. Honest today, and the obvious first thing to add if
  people stop reporting because it feels like a void.
- **A suspension can only be lifted through the report that imposed it.**
  `DISMISS` on that row clears `auth.User.suspendedAt`; there is no endpoint
  that lifts a suspension on its own, and no way to suspend somebody without a
  report to hang it on. If the report is later deleted with the reporter's
  account, the suspension outlives its undo and the only way back is a
  statement against the database. A `POST /api/moderation/users/:id/reinstate`
  is the fix, and it is a route rather than a rule.
- **Suspension is not a sign-out.** It is checked at four write seams, so a
  suspended account keeps a valid session and everything it can read. Nothing
  in the types makes a fifth write seam call `assertNotSuspended`; the list in
  the header of `services/moderation.ts` is enforced by somebody reading it.
- **Hiding a thread does not hide its replies.** Deliberate — a reply is
  somebody else's words — but the replies become unreachable, because the only
  way a reader lists them is by opening the thread that is now gone. They are
  neither hidden nor visible, which is a third state nothing names.
- **The duplicate-report rule has a race.** One open report per reporter per
  target is an `INSERT ... WHERE NOT EXISTS`, not a unique index, because no
  index can say "unique only while open". Two requests in the same instant can
  both pass it. Resolving sweeps every open report on the target, so the
  leftover costs a moderator nothing — but the rule is a convention the service
  keeps rather than one the database enforces.
- **Notifications written before the migration cannot be swept.** `sourceType`
  and `sourceId` are null on every row that predates Task 15, so hiding a
  comment from before it landed leaves the copy in somebody's bell. Nothing can
  be done about those rows: an excerpt is a prefix of a body, not a key.
- **Nothing prunes resolved reports.** The same note the notification and
  analytics tables carry. A resolved report is read by nobody and kept
  forever.
- **Unseen in a browser:** the reason dialog at phone width, where seven
  radio rows and a textarea have to fit above the fold with the footer still
  reachable; the overflow menu inside `.comment-replies`, which is a narrow
  indented column; and the menu on the last post of a long channel feed, where
  `DropdownMenu` has to flip to the top side.

### Badges and levels (Task 12)

- **~~A newly earned badge is announced by the browser, not by the server.~~**
  Closed by Task 14. The `localStorage` diff in `newlyEarnedSince` and the
  toast on `/badges` are both gone; the award now writes a `BADGE_EARNED`
  notification as it lands, which reaches the reader wherever they are and on
  every device. What is left of the gap is the delay: the bell polls, so the
  telling is up to a minute late.
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
  a step is silent. Task 14 did *not* close this, though it closed the badge
  half of it: a level is derived on every evaluation rather than awarded, so
  there is no "it just happened" moment to hang a notification on the way
  `insertBadge`'s returned row is. Storing the last-announced level on
  `auth.User` would make one, and that is a migration rather than a rule.
- **Unseen in a browser:** the three-meter row on `BadgesPage` at phone width,
  where `.badges__meters` drops to one column; and the badges tab on somebody
  else's profile with nothing earned.

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
  from a finished board. Task 15 did not take it up: a challenge entry is not
  one of the three things `ReportTarget` names, and the queue acts on text
  somebody wrote rather than on a place in a ranking. It is still a fifth
  target type and a fourth action whenever somebody wants it.
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
