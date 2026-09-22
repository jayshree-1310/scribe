# Scribe — Implementation Backlog

What is left to build, and in what order. Derived from the gap between the
frontend surface (`apps/web/src/pages`) and the API (`apps/api/src/routes`).
**That gap is closed.** Task 17 deleted `data/api.ts`, `data/mock-db.ts` and
`types/domain.ts`, so there is no mock data in the repository and every screen
reads an endpoint. What remains in this document is the record of why things
are the way they are, and **What is left** below — the open questions sorted
into the ones somebody has to build, the ones somebody has to open a browser
to confirm, and the ones already decided.

**Landed tasks are not kept here.** Each one's decisions live in the header of
the service that owns them — that is the file somebody changing the behaviour
has open, and a second copy in this document could only go stale. What *is*
kept is the list below, so a task can name its dependencies, and the open
questions at the end, which are outstanding rather than done. A question is
outstanding until the section it lives in is rewritten or it is struck through
in place — closing one by deleting it loses the reason it was ever open.

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
| Retiring the mock layer (Task 17) | `lib/auth.ts`, `components/providers/AuthProvider.tsx` |

### What is left

No *task* is left: every numbered task above has landed, and the last one could
only be last, because nothing could be removed from the mock layer until
everything that read it had somewhere else to read from.

What is left is the open questions below — 77 of them, and they are not one
kind of thing. Some are a bug somebody has to fix, some are a browser somebody
has to open, and some are a decision already made that only needs to stay made.
Reading them as one undifferentiated list is what made "nothing is left" look
true. This is the same set sorted by what it asks of you, each line pointing at
the section that explains it. Audited 2026-09-22.

#### Bugs — fixed

All three are closed. Kept here, struck through, because the next person to
touch these three places is better off knowing what they used to do.

- [x] **~~`POST /api/library` writes the row and then answers 404.~~**
      `requireBook` filtered on nothing but the id, so a `SCRIBE` story passed
      it and the row was created; the response then hydrated through `getBook`,
      which is `catalogueOnly`, and the caller was told it had failed while the
      row sat there. The rule now runs before the write, through
      `catalogueIdsAmong` in `services/books.ts` — one place that says what the
      shelf can hold, asked by the guard and by the counters both. A real story
      id now gets a 400 saying so rather than a 404 denying it exists.
      `countsFor` was the same bug's other half: it counted every row while
      `listLibrary` rendered only catalogue ones, so a legacy row still put a
      number on a tab that showed nothing.
- [x] **~~`useReadingProgress` stops saving for the rest of the page load~~** on
      the first 401/403. `blockedRef` was keyed on the mount; it is
      `blockedForRef` now and keyed on the reader, because a 401 says *this*
      reader may not save rather than that this page may not. Signing in with
      the reader open resumes saving on the next tick.
- [x] **~~A late-growing chapter restores short.~~** The restore still measures
      one frame after paint, but it now keeps a `ResizeObserver` on the body for
      `RESTORE_SETTLE_MS` and re-applies the proportion as the page grows,
      standing down the moment the reader scrolls themselves
      (`SETTLE_TOLERANCE_PX`). **Still wants a browser**: the numbers are
      reasoned, not tuned, and no test drives a chapter whose media arrives
      late. Moved to the check list below rather than called done.

#### Surfaces that were never built — implement

Each is a route and a component; none is blocked on API work that does not
already exist.

- [ ] **A notifications page.** The dropdown holds the newest twelve with no
      "see all", so a week of ignoring the bell loses the tail.
      `GET /api/notifications` is already paginated. § Notifications
- [ ] **A moderator UI.** The queue has never been read by a person; the only
      way to make an administrator is `pnpm --filter api admin:grant`.
      § Moderation and reporting
- [ ] **A challenge host UI.** Create and edit are reachable with a token and
      have never been exercised by a person. § Writing challenges
- [ ] **Tell an author their content was hidden.** Today it simply vanishes and
      an edit of it 404s. Needs a sixth `NotificationType` and a decision about
      how much of the reason to reveal. § Moderation and reporting
- [ ] **Tell a reporter what happened to their report.** Filed into a void,
      whichever way it went. § Moderation and reporting
- [ ] **`POST /api/moderation/users/:id/reinstate`.** A suspension can only be
      lifted through the report that imposed it, so a deleted report strands it.
      § Moderation and reporting
- [ ] **An endpoint for somebody else's clubs and shelves.** Those profile tabs
      are gated on the profile being your own because nothing answers them for
      anyone else. § Public profiles and follows

#### Columns the behaviour is waiting on — implement

Each of these is a migration rather than a rule change, and each closes a gap
that cannot be closed without it.

- [ ] **`longestStreak` on `auth.User`.** `streakDays` is the current run, so
      "read 30 days in a row" is only earnable while the run is still alive.
      § Badges and levels
- [ ] **A last-announced level on `auth.User`.** A level is derived on every
      evaluation rather than awarded, so there is no moment to hang a
      notification on and crossing a step is silent. § Badges and levels
- [ ] **The furthest onboarding step reached.** Saving per step is what makes a
      refresh resume, but a reader who quits at the author step is put back at
      step one. § Preferences and recommendations

#### Invariants only a comment enforces — implement

These are already correct everywhere today. What is missing is anything that
keeps the next writer from getting them wrong.

- [ ] **`flushBadges()` must settle before `flushNotifications()`.** Draining
      the two in parallel loses the badge notification about one time in ten.
      § Notifications
- [ ] **A fifth write seam must call `assertNotSuspended`.** The list of four is
      enforced by somebody reading the header of `services/moderation.ts`.
      § Moderation and reporting
- [ ] **A skeleton must gate on `status`, never on `data`.** Six surfaces had it
      wrong and were fixed; the list was found by reading rather than by a test,
      so neither its completeness nor its durability is proved. § Retiring the
      mock layer

#### Check in a browser — may need no work at all

Nothing here is known to be broken. Each is a state the test suite cannot reach,
so the honest status is unknown rather than done.

- [ ] **The ten "unseen in a browser" sets**, one at the end of each section
      below — mostly phone-width layout, plus a few sequences the suite cannot
      drive.
- [ ] **The re-applied restore, against real media.** `RESTORE_SETTLE_MS` and
      `SETTLE_TOLERANCE_PX` were chosen by argument. What wants watching is a
      chapter whose video reports its size late — that the reader lands on the
      right paragraph, and that nobody who has started reading gets moved.
      § Reading progress
- [ ] **The streak across a real midnight.** `advanceStreak` is unit tested
      against a controlled clock for every branch, but the wiring has only met a
      backdated anchor, never the database's own `now()` rolling over a UTC day.
      § Reading progress
- [ ] **The optimistic failure paths.** The Follow button's roll-back and the
      notification mark-read roll-back have only ever run on the happy path;
      both want a throttled or offline browser. § Public profiles and follows,
      § Notifications
- [ ] **The dev-identity gap, once the dev header goes.** With no session the
      API answers for whoever `readerHeaders()` names, which crosses clubs,
      channels, comments, profiles, challenges, notifications and reading saves,
      and also hides Delete on your own posts. Expected to disappear wholesale
      rather than seam by seam — worth confirming that it does. § Clubs and
      channels

#### Right at today's row counts, wrong later — not now

Deliberately not scheduled. Each names the shape that replaces it, so none of
them is a surprise when it arrives.

- **Nothing prunes anything.** The analytics event tables, the notification rows
  and resolved reports all only grow. Read notifications past some horizon are
  the obvious first thing to drop.
- **Nothing records a click on a recommendation**, so the `WEIGHTS` cannot be
  tuned against behaviour — that event is the prerequisite for touching a single
  number. The ranking itself is a full scan of every listed Scribe story.
- **Club notification fan-out is a row per member per thread**, which a club of
  ten thousand makes untenable; the fix is fan-out-on-read, a different table.
- **`members` and `subscribers` sorts hydrate the whole filtered set** and slice
  it in JS, because the ORM cannot order by an aggregate. `db.sql` with a join.
- **Followers and the leaderboard are offset-paged**, so a row can cross a page
  boundary mid-scroll. Keyset cursors if either list ever gets long.
- **The web response types are hand-copied** from the services they mirror. Doing
  it properly is a third workspace package and fourteen files; declined rather
  than half-done, and each file names its source of truth instead.

#### Settled — no action, do not reopen

Recorded so that finding them again does not start an investigation: the
notification rows predating Task 15 that carry a null `sourceType` and can never
be swept; the duplicate-report race, which no index can express because none can
say "unique only while open"; the replies of a hidden thread, which are neither
hidden nor visible; catalogue editions recording no reading position; the two
clock-skew windows (challenge open/close and the visitor digest's day); the
seeded `viewCount` that flatters both analytics and *Popular Writer*; a mute not
being retroactive; and the four things Task 17 removed rather than replaced —
the weekly reading goal, `hiatus`, `AuthorCard` and `GenreCard`.

New work goes in `AI-BACKLOG.md`, or in a new task here written to the house
rules above.

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

## Open questions from landed work

Things the test suite cannot reach — browser behaviour, real clocks, layout.
Each is a known gap, not a suspicion: worth confirming by hand, and worth
folding into whichever task next touches that surface.

### Retiring the mock layer (Task 17)

- **The types are still two hand-written copies, and the task allowed for
  that.** The instruction preferred generating or sharing the response shapes
  from the API over maintaining `apps/web/src/types/*` by hand. The services do
  export them — `PublicProfile`, `FollowEntry` and the rest are declared in
  `services/users.ts` exactly as `types/users.ts` re-declares them — so the
  obstacle is packaging, not discipline: `apps/web` is its own workspace with
  its own `tsc -b`, and importing from `apps/api/src` would put Prisma and
  Express in the web app's typecheck graph. Doing it properly means a third
  workspace package holding the response types, imported by both, and every
  service moving its interfaces into it. That is a refactor of fourteen files
  and ~1,400 lines across a package boundary, so it was declined rather than
  half-done. What landed instead is the fallback the task named: one file per
  service, each headed by the `apps/api/src/services/*.ts` it mirrors, which is
  the comment pointing at the source of truth.
- **`Session.user` is `AccountProfile` itself**, aliased as `SessionUser` in
  `lib/auth.ts` rather than re-declared. So the session cannot drift from
  `GET /api/account/me`: a field the endpoint stops serving fails to compile at
  every reader. `Session` deliberately did *not* move into `types/`, because
  everything there mirrors a service response and this is a client-only
  wrapper.
- **The session is still a `localStorage` cache of a profile.** It is
  revalidated once per load and adopted on save, which was true before this
  task and is more visible now that nothing fills the gaps: a field the API
  adds is absent from a stored session until the next `/account/me` answers.
- **Two components went with the layer rather than being rewritten.**
  `AuthorCard` and `GenreCard` were unimported, and the fields that gave them
  their shape — a `bio` and `followerCount` on one object, a genre blurb — are
  not carried together by any response. Their CSS went with them, the way
  `.post__foot` did in Task 10.
- **The home page's weekly reading goal is gone, not replaced.** It ran on
  `minutesReadThisWeek`, and no reading duration is recorded anywhere, so
  there was nothing honest to compute. The meter is the reader level now,
  which is chapters read against the next level's threshold — the same
  `GET /api/badges` response the badges page draws. Reinstating a time goal
  means recording time, which is a column and a client that measures it.
- **`hiatus` left `CardStory` and nothing replaced it.** The API derives three
  statuses from `listedAt` and `isCompleted`; a story on hold is `ongoing`. The
  editor's status select already said so (`StoryEditorPage`), so the card was
  the last place the fourth state was mentioned.
- **The audit found six surfaces that read `data` where they meant `status`.**
  Under a mock that never failed and always answered in 260ms, "the list is
  empty" and "the list has not arrived" and "the list failed" were one
  condition, and six places had written it that way: the sign-in aside (three
  covers that pulsed forever on a failure), the home page's clubs and
  challenges rails, the profile's reading shelf, recent badges and whole
  activity tab, the channels page (whose failed *subscribed* request silently
  un-filtered Discover), the challenge entry dialog (an empty story picker that
  submits an empty id), the dashboard's channel section, and the story editor's
  genre picker (a writer blocked by "Pick at least one genre" with no chips to
  pick). Each now reads `status` first. **What has not been proved is that the
  list is complete** — it was found by reading, not by a test, and nothing in
  the types stops the next page gating a skeleton on `data`.
- **Unseen in a browser:** every state above, since provoking them means
  failing a request. The reader level meter in the home page header at phone
  width; the sign-in aside with its covers dropped, where `.auth__covers`
  leaves a gap the quote has to close; and the genre picker's inline retry
  inside `.editor__details-genres`.

### Reading progress (Task 2)

- **~~A late-growing chapter restores short.~~** Fixed: the first measurement
  is still one `requestAnimationFrame` after paint, but a `ResizeObserver` on
  the body re-applies the proportion for `RESTORE_SETTLE_MS` afterwards, which
  is the window a chapter's media has to report its intrinsic size in. It
  stands down as soon as the page is more than `SETTLE_TOLERANCE_PX` from where
  the restore put it, because that means the reader is scrolling and their
  position beats the saved one. What is left of the gap is that both constants
  are reasoned rather than tuned, and that no test drives late media — it still
  wants the browser the original note asked for, now to confirm rather than to
  design.
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
- **~~`useReadingProgress` stops saving for the rest of the page load~~** once
  the API answers 401/403. Fixed as the note suggested: the block is keyed on
  the reader (`blockedForRef`, read from `useAuth`) rather than on the mount, so
  a 401 silences saves for the person it refused and nobody else. Signing in
  with the reader page open resumes on the next debounce, and signing *out*
  costs one rejected request before the new identity is refused in its turn.
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
- **~~`POST /api/library` cannot shelve a Scribe story~~ — it now says so
  before writing anything.** Not this task's code, but this task is where it
  showed up: `addToLibrary` accepted any `Story` id, wrote the row, and then
  404ed hydrating the response through `getBook`, which is catalogue-only — the
  caller was told it failed and the row was there. `requireBook` asks
  `catalogueIdsAmong` now, so the refusal happens before the write and reads as
  a 400 explaining the rule rather than a 404 denying the story exists.
  `countsFor` counts from the same set the shelf renders, so a row written
  before this no longer inflates a tab that shows nothing. The *rule* is
  unchanged and still the point: the "already finished" exclusion reaches a
  *story* through reading history and a *book* through the shelf, and
  `routes/recommendations.test.ts` says so where it tests both.

  Two things this deliberately did not do. Shelving Scribe stories is a
  feature, not a bug fix — the shelf has been catalogue-only since Task 1, and
  making it otherwise means a `getBook` that answers for both sources. And
  legacy rows pointing at Scribe stories are left in place: they are invisible
  and inert, and `DELETE /api/library/:id` still removes them, but deleting
  somebody's rows in a migration is not a call to make on their behalf.
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
