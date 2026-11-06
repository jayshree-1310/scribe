# Review and test findings — 2026-11-05

A full pass over Scribe: automated gates, a live sweep of every API endpoint
against the dev stack, a headless-browser pass over every web route, and a
code review of the API and web app. Nothing in the app was changed; this file
is the list to fix from.

Every finding has an ID so fixes can reference it. **Severity:** High (data
loss, security, or a core feature that fails outright), Medium (wrong
behaviour a user will hit), Low (edge case, polish, tech debt). **Status:**
*Confirmed* means reproduced live with the steps given; *Code review* means
found by reading the code and not yet reproduced.

---

## 1. What was run

| Check | Result |
| --- | --- |
| `tsc --noEmit` (api) | pass |
| `tsc -b` (web) | pass |
| `pnpm --filter web lint` (async-gating + eslint) | pass, 0 errors |
| `vite build` (web) | pass. Warning: one 690 kB JS chunk (see L-14) |
| `tsc -p tsconfig.build.json` (api) | pass |
| API suite `vitest run` | **60 files, 1150 tests, all pass** (113 s) |
| Live API sweep (throwaway `rv_*` accounts on the dev stack) | ~230 checks; failures listed below |
| Headless Chrome over every route, signed in and signed out | all 45 routes render; issues below |

Scripts and raw output live in the session scratchpad (`h.mjs`, `t1`–`t7`,
`browse.mjs`, `live-log.txt`, `browser/results.json`), not in the repo.
Every throwaway account and everything it created was removed afterwards
through the test harness teardown; the dev DB holds no review data.

**Totals:** 10 High · 14 Medium · 22 Low · 3 environment notes.

### What passed and does not need work

So the list below is not read as "everything is broken":

- **Auth and sessions:** signup, login (case-insensitive email),
  refresh rotation, replay detection, logout, logout-all, change password
  revoking other sessions, forgot/reset (single-use token, same answer for
  unknown emails), verify email, and an email change clearing `emailVerified`.
- **Authorisation:** drafts and unpublished chapters are hidden from other
  users on every read path, including search, profile lists, comments,
  ratings, likes, reading progress and all AI endpoints. Author-only, owner-only
  and admin-only routes refuse other callers. Anonymous calls to protected
  routes get 401. Other users' AI conversations and bible facts are
  unreachable. `PATCH /me` cannot set `isAdmin`. A bad bearer token and a
  non-UUID dev header both answer 4xx, not 500.
- **Features:** follow, notifications (mark read, read-all, clear), reading
  progress and continue-reading, idempotent likes, comment threads (replies
  flatten to one level), ratings and averages, chapter reorder, chapter delete
  and renumber, publish/unpublish, author analytics, club roles (last-owner
  guard, admin cannot remove owner), channel posting rules, moderation
  report → hide + suspend → reinstate, challenges (window validation, entry
  ownership), recommendations, badges, preferences, every story sort.
- **Validation:** malformed JSON → 400, oversized body → 413, fractional
  rating → 400, whitespace comment → 400, out-of-range onboarding step → 400,
  SVG and non-media uploads rejected.

---

## 2. High

### H-1 · Deleting a club thread with 2+ replies fails (500) — Confirmed
- **Where:** `apps/api/src/services/clubs.ts:1168` (`deleteDiscussion`)
- **Repro:** post a thread, add two replies, `DELETE /api/clubs/discussions/:id`
  as the author or a club admin.
- **Actual:** 500, `clubDiscussion_parentId_fkey`.
- **Cause:** `.where(...).delete()` removes **one row per call** in this ORM,
  so only one reply goes before the thread delete. `deleteAll` exists for this
  (see `prisma/delete-all.ts`).
- **Fix:** `deleteAll(() => tx.orm.clubs.ClubDiscussion.where(parentId = id))`.

### H-2 · Deleting a club with 2+ members or 2+ discussions fails (500) — Confirmed
- **Where:** `apps/api/src/services/clubs.ts:701` (`deleteClub`)
- **Repro:** club with 3 members and 2 threads → `DELETE /api/clubs/:id`.
- **Actual:** 500, `clubDiscussion_parentId_fkey`; with no discussions it
  would fail next on memberships.
- **Cause:** the same one-row `.delete()` used for replies, discussions and
  memberships.
- **Fix:** `deleteAll` for each, replies before threads.

### H-3 · Deleting a channel with 2+ posts or 2+ subscribers fails (500) — Confirmed
- **Where:** `apps/api/src/services/channels.ts:454` (`deleteChannel`)
- **Actual:** 500, `channelPost_channelId_fkey`.
- **Fix:** `deleteAll` for posts and subscribers.

### H-4 · An author cannot delete a story anyone has viewed (500) — Confirmed
- **Where:** `apps/api/src/services/authoring.ts:509` (`deleteStory`)
- **Repro:** publish a story, open it as another user (or signed out),
  then `DELETE /api/author/stories/:id`.
- **Actual:** 500, `chapterRead_chapterId_fkey`.
- **Cause:** `deleteStory` never removes `engagement.storyView` /
  `engagement.chapterRead` rows. `deleteAccount` does
  (`services/account.ts:501-506`); the two sweeps have drifted apart.
- **Fix:** delete both tables by `storyId` before the chapters. Better: one
  shared "remove a story" helper used by both `deleteStory` and
  `deleteAccount`.

### H-5 · Deleting a story whose comments have 2+ replies fails (500) — Confirmed
- **Where:** `services/authoring.ts:562` and `services/account.ts:510`
  (`deleteAll(Comment.where(storyId))`), plus `services/account.ts:580`
  (the caller's own comments).
- **Repro:** a thread on the story with two replies → delete the story.
- **Actual:** 500, `comment_parentId_fkey`. `deleteAll` picks an arbitrary
  row each round, and it can pick a parent before its children.
- **Also:** an account whose comment on *someone else's* story has replies
  from third parties cannot be deleted (the user-comment sweep hits the same
  constraint).
- **Fix:** delete rows with `parentId IS NOT NULL` first, then the rest — or
  one raw `DELETE … WHERE "storyId" = $1` (Postgres checks the constraint at
  statement end, so self-references in the same statement are fine).

### H-6 · A story that is any club's current read cannot be deleted (500) — Confirmed
- **Where:** `services/authoring.ts:509`, `services/account.ts:442`
- **Repro:** user B's club sets user A's story as its current read; A
  deletes the story (or their account).
- **Actual:** 500, `bookClub_currentStoryId_fkey`. Someone else's club
  setting blocks an author's delete.
- **Fix:** `UPDATE clubs."bookClub" SET "currentStoryId" = NULL WHERE
  "currentStoryId" = $story` inside both deletes.

### H-7 · Account deletion fails for most active users (500) — Confirmed
- **Where:** `apps/api/src/services/account.ts:387` (`deleteAccount`)
- **Confirmed failures:**
  - posted any club discussion → `clubDiscussion_userId_fkey`
  - owns a story with a reply thread → H-5
  - owns a story that is a club's current read → H-6
- **Found by comparing the DB's foreign keys with the sweep (not yet
  reproduced):**
  - created a club that has discussions: the club loop deletes memberships,
    then the club, but never `clubs.clubDiscussion` (FK `clubId`).
  - hosted a challenge: `challenges.writingChallenge.hostId` is never handled
    (admins only).
- **Impact:** GDPR-style "delete my account" returns "Something went wrong"
  to most real users. During this review **every** cleanup of a test account
  that had touched clubs or comment threads failed this way.
- **Fix:** handle the tables above, and add a test that builds a user who
  has touched every table and then deletes them. Listing
  `information_schema` foreign keys onto `auth.user` / `content.story` in that
  test would catch the next table added.

### H-8 · Any user can delete any other user's uploaded files — Confirmed
- **Where:** `apps/api/src/lib/storage.ts:139` and `:271` (`remove`), called
  from `services/authoring.ts:495` (`updateStory` cover replace),
  `removeMultimedia`, `deleteChapter`, `deleteStory` via `discardUpload`.
- **Repro (local backend):**
  1. A uploads an avatar → `/uploads/avatars/<uuid>.png` (the URL is public
     on A's profile).
  2. B: `POST /api/author/stories { coverUrl: <A's avatar URL> }` — accepted.
  3. B: `PATCH /api/author/stories/:id { coverUrl: "" }`.
  4. A's avatar URL now returns **404**, while A's profile still points at it.
- **Same via:** adding a multimedia attachment with someone else's URL then
  `DELETE /api/author/multimedia/:id`, or deleting the chapter or story. On S3
  the `remove` path is identical (any key under `S3_PUBLIC_BASE_URL`).
- **Cause:** `coverUrl` and multimedia `url` are free strings from the
  client, and `remove()` deletes whatever file the string names. Nothing
  records which account uploaded a file.
- **Fix:** record uploads (owner id + key) when `POST /api/uploads` and
  `/avatar` store them; only accept cover/media URLs that the caller
  uploaded (or external `https:` URLs, which are then never deleted); have
  `discardUpload` delete only files owned by the caller.

### H-9 · Google sign-in can attach to an account pre-registered by someone else — Code review
- **Where:** `apps/api/src/routes/auth.ts:362-385`
- **Scenario:** an attacker signs up with `victim@gmail.com` and a password
  (email is never verified). Later the real owner signs in with Google. The
  code links the Google id to the attacker-created row, sets
  `emailVerified: true`, and revokes sessions — but **keeps the attacker's
  `passwordHash`**. The attacker can log in with their password at any time
  and sees everything the victim does from then on (classic account
  pre-hijacking).
- **Fix:** when adopting an unverified password account by email, either
  clear `passwordHash` (the owner can set one via `/set-password`), or
  refuse to link and ask the user to sign in with the password first. Only
  auto-link when the existing row's email was already verified.

### H-10 · Uploads are down in dev: the Supabase project is paused — Confirmed (environment)
- **Symptom:** every `POST /api/account/avatar`, `POST /api/uploads` (cover
  and media) returns **500 internal_error**. The API log shows
  `@aws-sdk XML parse error`, `httpStatusCode: 540`. **HTTP 540 is Supabase's
  "project paused" response** (free projects pause after inactivity).
- **Where:** `apps/api/.env` `S3_*` → `ztpgrizoocebkwzvkvnk.supabase.co`.
  If production uses the same project, uploads are down there too — worth
  checking.
- **Code-side issues it exposed:**
  - an object-store failure surfaces as a generic 500, not a 503 with a
    useful message (`lib/storage.ts` lets SDK errors through).
  - `/health` reports `storage: { backend: "s3" }` and `status: ok` without
    probing the bucket, so this outage is invisible to the health check.
- **Fix:** restore/unpause the Supabase project (or move to R2 as
  `render.yaml` suggests); map storage errors to `HttpError.unavailable`.

---

## 3. Medium

### M-1 · A second tab (or a quick reload) can sign the user out everywhere — Confirmed
- **Where:** `apps/api/src/routes/auth.ts:153-205`; web
  `components/providers/AuthProvider.tsx`, `lib/access-token.ts`
- **Repro:** refresh with cookie C → rotated to C2. A second request still
  carrying C (another tab that loaded at the same moment, or a request already
  in flight) → 401, and **the whole family is revoked**, so C2 stops working
  too. Two exactly-parallel refreshes → one 200, one 401.
- **Impact:** opening the app in two tabs, restoring a browser with several
  Scribe tabs, or reloading mid-request logs the user out. The losing tab also
  runs `persist(null)`, wiping `scribe:session` from `localStorage` for every
  tab.
- **Fix:** a short grace window (e.g. 10–30 s) during which the previous
  token in a family returns the *current* session instead of burning it; and
  on the web side, serialise refreshes across tabs (`navigator.locks` or a
  `BroadcastChannel`).

### M-2 · Google sign-in overwrites a custom avatar on every login — Code review
- **Where:** `apps/api/src/routes/auth.ts:357-361`
- Returning Google users get `avatarUrl: identity.picture` on each sign-in.
  An avatar uploaded in Settings is replaced, or cleared when Google sends no
  picture. The uploaded file is orphaned in storage. The comment says "never
  overwrite a name the user set"; the avatar needs the same rule
  (`user.avatarUrl ?? identity.picture`), as the link-by-email branch already
  does.

### M-3 · `Story.likeCount` is never updated, so "Trending" and analytics ignore real likes — Confirmed
- **Where:** column written only by the seed scripts; read by
  `services/stories.ts:559` (trending sort), `:1057` (related rail),
  `services/analytics.ts:534` (author "likes"), and the badges/levels
  metrics.
- **Repro:** like a chapter → story `likeCount` stays **0**; the author
  analytics overview shows `lifetime.likes: 0`.
- **Impact:** seeded stories permanently outrank member stories on
  Trending; authors see 0 likes on their dashboard.
- **Fix:** maintain it from `engagement.chapterLike` (increment/decrement in
  `setLike`), or compute it from the like table at read time.

### M-4 · Comments can be attached to an unpublished chapter — Confirmed
- **Where:** `apps/api/src/services/engagement.ts:474`
- **Repro:** B posts `{ chapterId: <unpublished chapter of a listed story> }`
  → **201**. The author gets a notification linking to
  `/read/<slug>/<n>` for a chapter readers cannot open.
- **Fix:** check the chapter through `findVisibleChapter` (published or
  caller-authored), as likes already do.

### M-5 · Authors can rate their own stories — Confirmed
- **Where:** `apps/api/src/services/engagement.ts:915` (`upsertRating`)
- `PUT /api/stories/:id/rating {rating: 5}` by the author → 200; the
  average and the "rating" sort move. Chapter likes have the same gap.
- **Fix:** refuse (403) when `story.authorId === userId`.

### M-6 · Password reset and email verification cannot work in production — Code review (config)
- **Where:** `apps/api/src/lib/mailer.ts`, `render.yaml`
- Only the `log` transport exists, and `render.yaml` sets neither
  `MAIL_TRANSPORT` nor `WEB_APP_URL`. In production:
  - no email is ever sent; "Forgot password" silently does nothing.
  - links would point at `http://localhost:1302`.
  - the full reset link (a live credential for 30 min) is written to
    production logs at `info` level.
- **Fix:** add a real transport (the file already marks the spot); set
  `WEB_APP_URL`; refuse the `log` transport when `NODE_ENV=production`, or at
  least do not log message bodies there.

### M-7 · Chapter attachment URLs and cover URLs are not validated — Confirmed
- **Where:** `apps/api/src/routes/authoring.ts:64` (`coverUrlSchema`),
  `:128` (multimedia `url`)
- `POST /api/author/chapters/:id/multimedia {type:"LINK",
  url:"javascript:alert(document.cookie)"}` → **201**. It is rendered as
  `<a href>` in `components/story/ChapterAttachment.tsx:63`. React 19 blocks
  `javascript:` hrefs at render time, so this is not exploitable today, but
  the API should not rely on that. `data:` and arbitrary hosts (tracking
  pixels) are also accepted. Ties in with H-8.
- **Fix:** accept only `https:` (and the app's own upload origin), checked
  with `new URL()`.

### M-8 · Uploads are never garbage-collected — Confirmed
- `POST /api/uploads` stores a file whether or not anything ever references
  it. Abandoned editor uploads, replaced Google avatars (M-2) and files from
  `deleteAccount` (story covers and chapter media are not removed there, only
  the avatar — `services/account.ts:707`) stay forever. Limits allow 30 ×
  128 MB per user per 15 minutes.
- **Fix:** track uploads (see H-8) and sweep unreferenced ones after a grace
  period; remove covers/media in `deleteAccount`.

### M-9 · A deleted account's access token gets 500s instead of 401 — Confirmed
- After `DELETE /api/account/me`, the still-valid access token (up to 15 min)
  on `POST /api/author/stories` and `POST /api/clubs` → **500**
  (`story_authorId_fkey` / `bookClub_creatorId_fkey`). Other routes answer 4xx.
- **Fix:** map FK violations on the user id to 401, or check that the user
  row exists in `requireUser` for write routes.

### M-10 · Suspended users can still edit public text — Code review
- **Where:** `apps/api/src/routes/suspension.test.ts:86-131` (recorded
  decisions)
- Recorded as exempt: `PATCH /api/channels/posts/:id` (rewrite a published
  post), `PATCH /api/clubs/:id` (club name/description), `PATCH
  /api/channels/:id`, and publishing stories/chapters (confirmed: a suspended
  user created a story → 201). A suspended author can therefore edit an
  already-visible post into the content they were suspended for.
- **Decision needed:** at least guard edits to already-public text
  (channel posts, club/channel descriptions, published chapters).

### M-11 · Stories, chapters, profiles, clubs and channels cannot be reported — Code review
- **Where:** `services/moderation.ts` `REPORT_TARGETS = COMMENT |
  CLUB_DISCUSSION | CHANNEL_POST`
- There is no way to flag an abusive story, chapter, bio/avatar, or club/
  channel description, and no admin hide for them.

### M-12 · "Remember me" on the login form does nothing — Code review
- **Where:** `apps/web/src/pages/LoginPage.tsx:25,125`; the argument is
  accepted and ignored in `components/providers/AuthProvider.tsx:138`.
  Unchecking it still keeps a 7-day (up to 30-day) session.
- **Fix:** issue a session cookie (no `maxAge`) when unchecked, or remove the
  checkbox.

### M-13 · Signed-out visitors cannot open a shared story link — Confirmed (product)
- `/story/:slug` and `/read/:slug/:n` redirect anonymous visitors to
  `/login`, although the API serves listed stories publicly and records
  anonymous views. Any link an author shares lands on a login wall.
- Product decision; noting because the backend was clearly built for public
  reading.

### M-14 · Club ADMINs (not owners) can delete the owner's club — Code review
- **Where:** `services/clubs.ts:707-713` (`["OWNER", "ADMIN"]`)
- A promoted member can delete the whole club, including the owner's
  discussions. (Currently masked by H-2, which makes the delete 500.)
  Consider owner-only.

---

## 4. Low

| ID | Finding | Where | Status |
| --- | --- | --- | --- |
| L-1 | Nested `<a>` inside `<a>` on /challenges: `Link` wraps `ChallengeCard`, which contains its own `Link`. React logs a `validateDOMNesting` error; invalid HTML and two tab stops per card. | `apps/web/src/pages/ChallengesPage.tsx:116`, `components/story/Cards.tsx:81` | Confirmed (browser) |
| L-2 | No `onError` fallback on cover/avatar `<img>`: a missing file shows a broken image instead of the generated cover/monogram. Seen live: a seeded story cover `/uploads/covers/451c79…png` and an avatar `/uploads/avatars/c9a0bf…jpg` point at files that no longer exist. | `components/story/StoryCover.tsx:72`, `components/books/BookCover.tsx:45`, `components/ui/Avatar.tsx:54` | Confirmed (browser) |
| L-3 | Generic 404 copy says "We couldn't find that **note** — it may have been deleted." (template leftover). | `apps/web/src/lib/api-client.ts:24` | Code review |
| L-4 | `/profile/:username` for an unknown user fires 5 requests (profile, stories, clubs, badges…) that all 404 before the page settles; the list requests could wait for the profile. | `apps/web/src/pages/ProfilePage.tsx` | Confirmed (browser) |
| L-5 | First-rating race: the comment says a concurrent insert is "caught below and retried as an update", but there is no catch, so a double-submitted first rating can 500 on the unique index. | `services/engagement.ts:915-944` | Code review |
| L-6 | A reader's rating bumps `Story.updatedAt`, so "last updated" moves when someone else rates. | `services/engagement.ts:839-845` | Code review |
| L-7 | `GET …/comments?parentId=<hidden thread>` still lists that thread's replies. | `services/engagement.ts:376-378` | Code review |
| L-8 | Anonymous view dedupe is IP + user agent per day: rotating the UA inflates `viewCount`, which drives the Views sort, Trending tie-break and author badges. | `services/analytics.ts:200-215` | Code review |
| L-9 | Rate limits are check-then-record (comments, discussions, uploads, AI), so parallel requests can exceed them. Use `INCR` first and compare. | `routes/engagement.ts`, `routes/clubs.ts`, `routes/ai.ts` | Code review |
| L-10 | `POST /api/ai/agent` with someone else's draft `storyId` answers 200 and spends a model call (tools correctly reply "not found"). Authorise the story up-front and 404 before calling the model. | `services/ai/agent-request.ts` | Confirmed |
| L-11 | Author-only routes answer **403** "not yours to edit" for another user's draft id but 404 for a random id, which confirms the draft exists. UUIDs make this hard to exploit. | `services/authoring.ts` `ownedStory` | Confirmed |
| L-12 | `JWT_REFRESH_EXPIRES_IN=30d` (render, `.env.example`) vs the hard-coded 7-day `REFRESH_SESSION_TTL_SECONDS`: the JWT outlives its Redis session, and the env var reads as if it controls something it does not. | `lib/sessions.ts:20`, `lib/jwt.ts` | Code review |
| L-13 | `deriveUsername`: `email.split("@")[0]` is never `undefined`, so the `?? identity.name` fallback is dead code. | `routes/auth.ts:303` | Code review |
| L-14 | Web bundle is one 690 kB chunk (199 kB gzip); no route-level code splitting (`React.lazy`) for author/AI/admin pages. | `apps/web` build | Confirmed |
| L-15 | `listGenres` loads every `storyGenre` row and every listed story into memory per request; `getRelatedStories` loads every story in the genre. Fine now, linear in catalogue size. | `services/stories.ts:1101`, `:1025` | Code review |
| L-16 | No upper bound on `page`: `?page=999999999` is accepted (returns empty, but issues a huge `OFFSET`). | list schemas in `routes/*.ts` | Confirmed |
| L-17 | `resolveReport` hides content, suspends the user and updates the report in separate statements with no transaction; a failure part-way leaves them inconsistent. | `services/moderation.ts:1043-1065` | Code review |
| L-18 | Job worker start moves **every** job in `jobs:running` back to ready, assuming they are orphans. Correct for one instance; with two API instances a restart re-runs the other's in-flight jobs. The dead list also keeps ids whose job hashes have expired. | `lib/jobs.ts` `startWorker` | Code review |
| L-19 | Leftover dev-user fallback: the comment in `current-user.ts` says to delete `X-Scribe-User-Id` "once the web app signs in for real", which it now does. In dev, signed-out requests from the web app are attributed to the demo user `…0001`, who has no `auth.user` row, so signed-out behaviour is never exercised locally and writes 500. | `middleware/current-user.ts`, `web/src/data/*-api.ts` `readerHeaders` | Code review |
| L-20 | Clubs and channels have no creation rate limit. | `routes/clubs.ts`, `routes/channels.ts` | Code review |
| L-21 | Access tokens stay valid up to 15 min after a password change, reset, suspension or account deletion (stateless JWT). Expected trade-off; worth knowing, and it is what makes M-9 reachable. | `lib/jwt.ts` | Confirmed |
| L-22 | `forgot-password` does a Redis write and logs/sends mail only when the address exists, so response time is a weak existence oracle (the body is identical). | `services/passwords.ts:161` | Code review |

---

## 5. Environment notes (not code bugs)

- **The dev DB has no catalogue books** (`content.story` has 0 `CATALOGUE`
  rows). `/api/books` and `/api/books/discover` return empty, Discover's book
  sections are empty, and the library cannot be used. `pnpm --filter api
  seed:books` was never run (or was undone) on this database. The API suite
  covers these paths with its own fixtures and passes.
- **Supabase storage paused** — see H-10.
- Groq free tier: AI calls closer than ~30 s apart get upstream 429s; the AI
  smoke test was paced for that.

---

## 6. AI features — live smoke test

Run against Groq `gpt-oss-120b` and local Ollama embeddings, paced 25 s
apart. **All 15 pass:**

chat · chat stream (SSE) · Scribble · assist (improve) · generate idea ·
generate refine · explain · Ask This Book (with citations) · conversation
message (streamed) · chapter recap · story summary · semantic search ·
bible read (job queued, 202) · continuity list · agent (tool call
`get_story_summary`).

The AI authorisation checks are in §1 (all pass) and L-10. The daily token
budget is enforced inside the provider wrapper (`services/ai/provider.ts:233`)
as well as on each route, so no AI route bypasses it.

---

## 7. Why the suite is green while the deletes fail

`apps/api/src/test/harness.ts` (`cleanup()`, from line 943) already removes
rows in the right order: club discussions with replies first, clubs before
stories because of `currentStoryId`, hosted challenges, every
`deleteAll` loop. Product code (`deleteStory`, `deleteAccount`,
`deleteClub`, `deleteDiscussion`, `deleteChannel`) does not. The tests also
never delete a club, channel, thread or story holding **more than one** child
row, so the one-row-per-call `delete()` never shows up.

The harness teardown is a ready-made template for H-1 to H-7. The missing
tests are "delete X with two of every child", one per entity.

---

## 8. Suggested fix order

1. **H-1 to H-7** (one root cause: delete paths): a shared `removeStory`
   helper, `deleteAll` everywhere a predicate can match many rows, and
   two-children tests per entity.
2. **H-8** (cross-user file deletion) together with **M-7** and **M-8**: an
   uploads table with an owner.
3. **H-9** (Google account pre-hijack) and **M-2** (avatar overwrite): both
   in the same block of `routes/auth.ts`.
4. **H-10**: unpause or replace the storage project; map storage errors to 503.
5. **M-1** (multi-tab sign-out), then the remaining Medium items.
6. Low items as convenient.
