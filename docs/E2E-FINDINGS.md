# End-to-end test findings — 2026-11-19

A browser run against both environments, after the review fixes in
`REVIEW-FINDINGS.md` landed. This file is the list to fix from; each item has
an ID so a fix can reference it.

**Severity:** High (a feature fails for users), Medium (wrong behaviour a user
will hit, or something that hides the cause of a failure), Low (polish,
environment, coverage). **Status:** Open, or Fixed with the commit's date.

---

## 1. What was run

Headless Chrome, driven over the DevTools protocol, against:

- **Local** — `http://localhost:1302` (the Docker dev stack)
- **Production** — `https://scribe-web-7mpz.onrender.com` (API `https://scribe-new.onrender.com`)

On each, in order:

1. Two new accounts registered **through the real sign-up form** and taken
   through all four onboarding steps in the UI: an author ("Mira Castell",
   answers *Yes — I already write*) and a reader ("Theo Lindqvist", *Just here
   to read*).
2. Real content created and **every non-DELETE endpoint** called from inside
   the signed-in page with each account's own session: 160 endpoints in the
   inventory, 137 that are not `DELETE`. Admin endpoints were exercised as an
   admin locally (the author was granted admin there) and checked to refuse a
   non-admin on production.
3. **Every page** visited as the author, as the reader and signed out — final
   URL, console errors, failing API calls and a screenshot each.

Nothing was deleted: no `DELETE` endpoint and no undo action (unlike, leave,
unfollow, unsubscribe) was called. Those paths are covered by the API suite.

| | Local | Production |
| --- | --- | --- |
| Sign-up + onboarding through the UI | 2/2 | 2/2 |
| Endpoint calls with the correct answer | **162 / 162** | **155 / 159** |
| Pages loading correctly (no console errors, no 5xx) | **55 / 55** | **49 / 49** |

"Correct answer" includes the refusals that are the right answer: 403 for an
author rating or liking their own work, 403 for a non-admin on moderation, 404
for somebody else's draft, 409 for a duplicate sign-up, 400 for a bad reset
token, 202 for queued AI jobs.

### Data the run left behind (deliberately)

Accounts — passwords are not recorded here; ask whoever ran it, or reset them.

| Environment | Author | Reader |
| --- | --- | --- |
| Local | `mira_writes_0793` (`mira.castell.0793@example.com`, admin locally) | `theo_reads_0793` (`theo.lindqvist.0793@example.com`) |
| Production | `mira_writes_8632` (`mira.castell.8632@example.com`) | `theo_reads_8632` (`theo.lindqvist.8632@example.com`) |

On both: the story *The Lamplighter of Saltmere* (three published chapters,
two comments, a reply, chapter and comment likes, a 5-star rating, reading
progress), the draft *Notes Toward a Winter Book*, the club *Saltmere Night
Readers* (a thread and a reply; the reader is an admin of it), and the channel
*Notes from the Lamp House* (one post; the reader subscribes). Locally only:
the writing challenge *The Fog Comes In*, created as admin.

On production these are visible to other people: each account followed one
suggested real author during onboarding; there is one report in the
moderation queue on the test channel post, labelled *"End-to-end QA check of
the report flow — safe to dismiss"*; and the reader's avatar is the 1×1 red
PNG the upload test sent (replace it in Settings).

---

## 2. Issues

### E-1 · Ask This Book fails on production: no embedder configured — High · Code side fixed (2026-11-20); needs Render settings
- **Seen:** `POST /api/ai/ask`, `POST /api/ai/ask/stream` and
  `POST /api/ai/conversations/:id/messages` all answer **503** on production.
- **Cause:** nothing sets `AI_EMBED_*` on Render, so the API falls back to the
  local-development default embedder, Ollama at `http://localhost:11434`
  (`services/ai/config.ts`, `EMBED_DEFAULTS`). There is no Ollama on Render.
  Semantic search (`GET /api/ai/search`) degrades quietly to keyword search,
  which is why it still answers 200; Ask This Book has no such fallback.
- **Fix:** set `AI_EMBED_PROVIDER`, `AI_EMBED_BASE_URL`, `AI_EMBED_API_KEY`
  and `AI_EMBED_MODEL` on Render to a hosted embedding service. The vector
  columns are 768-wide, so the model must return 768 dimensions (or set
  `AI_EMBED_DIMENSIONS` and migrate the columns). Groq serves no embedding
  models. Add the keys to `render.yaml` and `DEPLOYMENT.md`, then back-fill
  chapter chunks (`pnpm --filter api seed:embeddings`).
- **Done in code:** production no longer calls `localhost:11434`: an
  embedder left on a local address counts as unconfigured there, so Ask This
  Book answers at once with *"Embeddings are not configured on this server"*
  (search still falls back to keywords). `/health` now reports `ai.embed`
  (provider, model, host, width, `configured`), and the boot log names the
  missing settings. `AI_EMBED_SEND_DIMENSIONS=on` asks a hosted model for
  768-wide vectors, so models that default wider — `gemini-embedding-001` —
  can be used. `render.yaml` lists the `AI_EMBED_*` keys and
  `DEPLOYMENT.md` → *AI embeddings* gives the Gemini recipe.
- **Still to do by hand:** choose the provider, set the keys on Render, check
  Ask This Book, and back-fill with `seed:embeddings`. Google does not
  document whether its OpenAI-compatible endpoint honours `dimensions`; if it
  does not, the API refuses the 3072-wide reply with a message saying so, and
  a natively 768-wide model is needed instead.

### E-2 · Story bible extraction fails on production — High · Open
- **Seen:** `POST /api/ai/bible/:storyId/refresh` answers **502** *"The model
  could not complete that request"*, every time (retried by hand); the
  background `bible.read` job dead-letters after all three attempts with
  `upstream_error`. Every chapter stays `missing`.
- **Not reproducible locally:** the same three chapters, same provider, model
  (`openai/gpt-oss-120b` on Groq) and `AI_REASONING_EFFORT=low`, extracted
  22, 13 and 12 facts. Other structured calls (summaries, idea generation)
  succeed on production.
- **Likely cause:** the production Groq key. Extraction sends the largest
  prompt in the app (a chapter plus the fact schema), and a free-tier
  per-request token limit answers **413**, which the provider maps to this
  same 502. Unconfirmed, because of E-3.
- **Next step:** once E-3 is deployed, run the refresh again and read
  `upstream.status` and `upstream.code` on the `Request failed` log line on
  Render (or `job dead-lettered` for the background read). A 413 /
  `request_too_large` confirms the token limit; the fix is then smaller
  sections per extraction call (`services/ai/story-bible.ts`) or a key with a
  higher limit.

### E-3 · The model provider's actual error is never logged — Medium · Fixed (2026-11-19)
- **Where:** `services/ai/openai-compatible.ts` and `services/ai/ollama.ts`
  attach the provider's status and body to the error as `upstreamDetail`,
  but nothing logged it — neither the request error handler nor the job
  worker. A failing model call left only *"The model could not complete that
  request"* in the logs, which is why E-2 cannot be diagnosed.
- **Fix:** both now log `upstream: { status, code, type }` beside the error —
  the provider's HTTP status and its own short error code and type (Groq's
  `request_too_large`, `json_validate_failed` and the like). The provider's
  raw body is logged too only when `AI_LOG_CONTENT` is on, never in
  production, because it can quote the prompt — a member's unpublished prose
  (the rule `routes/ai-security.test.ts` enforces).

### E-4 · Readers are shown developer setup instructions — Medium · Fixed (2026-11-19)
- **Seen:** the 503 from E-1 tells the reader *"The model server at
  http://localhost:11434 is not reachable. Start it with `docker compose
  --profile ai up -d ollama`."* — and a missing model says *"Pull it with
  `docker compose exec ollama …`"*.
- **Fix:** in production the message is a plain *"AI features are
  unavailable right now"*; the address and the command go to the log instead.
  Development keeps the actionable text.

### E-5 · The product tour drags readers back to its page on every load — Medium · Fixed (2026-11-19)
- **Seen:** a new account that has not dismissed the tour is sent to the
  tour's current page (Home, for the first step) whenever it opens any URL —
  a shared story link, a new tab, a bookmark. Every page of the first local
  sweep landed on `/home` for this reason.
- **Cause:** the tour's state is saved per account and resumed on load, and
  resuming navigates to the step's route. Browser back/forward already made
  the tour step aside; arriving at a URL did not.
- **Fix:** a tour resumed on a page load continues only if the reader is
  already where its step happens; otherwise it steps aside, as it does for
  back/forward. A refresh mid-tour still resumes, and *Take a tour* in the
  account menu starts it again.

### E-6 · Local uploads answer 503 — Low · Fixed (2026-11-20, local `.env`)
- Avatar and cover uploads return **503** locally because `apps/api/.env`
  points `S3_*` at the paused Supabase project (review H-10). Production's
  storage works: the avatar and cover uploads succeeded there.
- **Cause, on a second look:** the Supabase project is no longer paused; the
  `scribe-media` bucket the local `.env` names does not exist in it
  (`NoSuchBucket`). Production uses a different bucket.
- **Fix:** the `S3_*` lines in `apps/api/.env` are commented out (with a note,
  not deleted), so local development stores uploads on disk in the
  `api_uploads` Docker volume — which is also where dev files belong, rather
  than in the hosted bucket. Verified: `/health` reports `storage.backend:
  local`, and a cover upload answers 201 and is served. `.env` is not tracked,
  so this was a local change only; uncomment the lines to test the object
  store on purpose.

### E-7 · A seeded cover file is missing locally — Low · Fixed (2026-11-20, local data)
- `/uploads/covers/451c794d-0f99-4ce4-9e4a-e2b05ff2da3c.png` 404s on most
  pages locally (a seeded story whose file is gone). It renders correctly —
  the generated cover shows (review L-2) — but every page logs the 404.
- The same account (`read_and_ruin_me`) also had a missing avatar,
  `/uploads/avatars/c9a0bfa2-f3d0-41d1-9669-033f993651bc.jpg`.
- Neither file exists anywhere on the machine, so both references were
  cleared in the local database (`content.story.coverUrl` of
  *the-time-between-us*, and that user's `avatarUrl`). The generated cover and
  monogram that already showed in their place still do. The old values are
  recorded here in case the files turn up; re-upload through the app to
  replace them.

### E-8 · Notification rows place the unread dot inconsistently — Low · Fixed (2026-11-20)
- On `/notifications` the unread dot sits right after the title text on some
  rows and at the far right edge on others, depending on the title's length
  (visible in the author's notifications screenshot).
- **Cause:** the text column was sized to its content, so the dot after it
  landed wherever the title ended.
- **Fix:** `.notification__body` takes the row's spare width (`flex: 1`), so
  the dot sits at the right edge on every row — in the bell's dropdown too,
  which shares the row. Checked on the local `/notifications` page.

### E-9 · The story editor has no page heading — Low · Open
- `/author/stories/:slug` renders no `<h1>`; the title is an input. Screen
  reader users land on a page with no heading to orient by.
- **Fix:** a visually hidden `<h1>` ("Editing *title*") or label the title
  input as the page heading.

### E-10 · One Render edge address is unreachable from the test network — Low · Open (network)
- From the network this run used, `216.24.57.16` (one of the two Cloudflare
  addresses `*.onrender.com` resolves to) never answers; `216.24.57.18` does.
  Browsers try the dead address first and wait out a timeout, so the first
  production attempt timed out at sign-up after ~45 s. The run was repeated
  with Chrome pinned to the working address.
- Not an application bug, and users elsewhere are unlikely to see it — but if
  they report slow first loads, this is where to look. Worth checking from a
  second network, and with Render if it persists.

### E-11 · `books.test.ts` pagination test fails under the full parallel suite — Low · Open
- *"returns a second page that does not repeat the first"* fails now and then
  when the whole API suite runs in parallel, and passes on its own. Other
  suites create listed stories at the same time, so the book pages it compares
  shift between its two requests. It can turn CI red for no reason.
- **Fix:** scope the test's listing to fixtures of its own (a genre or search
  term only this suite uses), so concurrent suites cannot move its pages.

---

## 3. Not covered, and why

| What | Why |
| --- | --- |
| `GET /api/books/:id`, `/related`, `POST/PATCH /api/library` | No catalogue books in either database (`pnpm --filter api seed:books`) |
| Challenge entry, detail and leaderboard on production | No challenges exist on production; covered locally |
| `POST /api/ai/continuity/findings/:id/dismiss` | The continuity check found nothing to dismiss |
| `POST /api/auth/google` with a real token | Needs a real Google sign-in; only the refusal of a bad token was checked |
| Password reset and email verification by link | No mail is delivered (review M-6); only the request and bad-token paths were checked |
| Every `DELETE` endpoint | Excluded by request; covered by the API suite |
