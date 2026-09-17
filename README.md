# Scribe

**Scribe** is a full-stack social reading and story publishing platform: readers
discover, read and shelve stories; authors write, publish and manage them.

The project is a rebuild with a production-oriented architecture — **React,
Node.js, TypeScript, PostgreSQL, Prisma and Docker** — and is under active
development. The frontend is complete as a design surface; the backend is being
filled in behind it, page by page, and the in-repo mock layer is down to its
last two callers. The section
[Where the project actually stands](#-where-the-project-actually-stands) says
which parts are real today.

A deployment runs on Render's free tier — [web](https://scribe-web-7mpz.onrender.com),
[API](https://scribe-new.onrender.com/health). The API sleeps after 15 minutes
idle, so the first request after a quiet spell takes a while to answer.

## 📍 Where the project actually stands

| Area                                                                      | State                                                |
| ------------------------------------------------------------------------- | ---------------------------------------------------- |
| Auth — email signup/login, refresh rotation, logout, Google sign-in       | **Real API**                                         |
| Passwords & email verification — forgot/reset, change, set, verify        | **Real API**                                         |
| Account — profile edits, avatar upload, account deletion                  | **Real API**                                         |
| Catalogue books — discover, filter, detail, related                       | **Real API**                                         |
| My Library — shelve, update, remove                                       | **Real API**                                         |
| Stories & chapters — public reading                                       | **Real API**                                         |
| Author studio — stories, chapters, reorder, publish/unpublish, multimedia | **Real API**                                         |
| Uploads — images (`kind=cover`) and chapter audio/video (`kind=media`)    | **Real API**                                         |
| Home feed, public profiles & follows, clubs, channels                     | **Real API**                                         |
| Comments, ratings, reading progress & streak                              | **Real API**                                         |
| Writing challenges & leaderboard                                          | **Real API**                                         |
| Author analytics — view / chapter-read events, daily series, per-story    | **Real API**                                         |
| Badges, reader & author levels                                            | **Real API**                                         |
| Scribble — the GenAI discovery concierge, JSON and streaming              | **Real API**                                         |
| Onboarding answers                                                        | **Mock** (`apps/web/src/data/api.ts` + `mock-db.ts`) |
| Notifications, moderation, recommendations                                | Not built — see `docs/BACKLOG.md`                    |
| The rest of the GenAI roadmap (AI 3 – AI 20)                              | Not built — see `docs/AI-BACKLOG.md`                 |

The planning documents drive the work, and all of them are grounded in the
current tree rather than in the abstract:

- `docs/BACKLOG.md` — the gap between the frontend surface and the API, as
  self-contained tasks.
- `docs/AI-BACKLOG.md` — the GenAI roadmap (AI 0 – AI 20). AI 0 (the provider
  seam) and AI 1.5 (Scribble, streaming included) have landed.
- `docs/ai-architecture.md` — how an AI request travels through the seam, and
  what each failure answers.
- `docs/content-model.md` — why there is one work entity (`content.Story`)
  rather than separate `Book` and `Story` models.
- `docs/DEPLOYMENT.md` — the Render deployment, service by service.

## ✨ Features

### 📖 Readers

- Browse and discover stories and catalogue books, filtered by genre
- Read stories chapter by chapter
- Shelve stories in a personal library with a status per shelf item
- Related-title suggestions
- Earn badges and a reader level from what you actually read, comment on and
  rate — awarded server-side, visible on your own profile and on other people's
- Ask **Scribble**, a conversational concierge, for something to read — see
  below

### ✍️ Authors

- Create and manage stories, with genres, cover and description
- Write chapters in a markdown editor with live preview and autosave
- Reorder chapters; publish or unpublish either a story or a single chapter
- Attach multimedia rows to a chapter
- A studio dashboard and an analytics view on real traffic: views, chapter
  reads, distinct readers and a per-day series over 7, 30 or 90 days

### 🤖 Scribble, the discovery concierge

Scribble turns a sentence — "something short and funny", "more like that but
kinder" — into catalogue filters, runs them against Postgres, and writes one
line about each row that came back.

**The model never produces a book.** It does two narrow jobs, routing and
narrating; title, author, description and URL are copied off the row and never
pass through a completion. A model asked to _recommend_ books invents titles
that do not exist, by authors who did not write them, at URLs that 404 — and
does it most confidently when the catalogue is small. Splitting the work this
way makes that class of failure structurally impossible rather than something
to prompt against.

Two routes, deliberately different contracts: a plain JSON one that retries
transient provider failures, and an SSE one that does not, because a stream
already half-written cannot be replayed. The stream sends the retrieved cards
as soon as Postgres answers — measured at 5.5s against `llama3.2:3b`, against
97s for the finished reply — which is the whole argument for streaming it.

Everything is generated behind `requireUser` and a per-user rate limit, the
model output is validated with Zod before it reaches the UI, and the generated
sentences are labelled as generated.

### 🔐 Authentication & authorization

- Email/password signup and login, with Argon2id password hashing
- Google sign-in (ID-token verification against a shared OAuth client id)
- Short-lived JWT access tokens; refresh tokens rotated and tracked in Redis,
  so a stolen refresh token can be revoked
- `logout` and `logout-all` (every session for the user)
- Password reset by emailed one-time token, password change for a signed-in
  caller, and `set-password` for an account that has only ever used Google
- Email verification, with the same one-time-token machinery
- Account deletion
- Per-IP _and_ per-address rate limiting on the auth routes: the first stops a
  script walking a list of addresses, the second stops anyone using Scribe to
  flood one person's inbox
- Ownership checks on every authoring mutation

### 🛡️ Platform

- Every `query` / `body` / `params` validated with Zod before it reaches logic
- Centralized `HttpError` with a closed `ErrorCode` union, one error handler
- Structured request logging (pino), `helmet`, configurable CORS
- Cursor/offset pagination, search and filtering on the list endpoints
- File storage behind one narrow interface with two backends — the local
  filesystem when nothing is configured, any S3-compatible object store when
  `S3_BUCKET` is set — and content sniffed from the bytes rather than trusted
  from the declared MIME type
- Large uploads streamed rather than buffered, so a video never becomes
  process memory
- SQL migrations checked into the repo
- Integration tests against a real database
- Fully dockerized development environment

## 🏗️ Architecture

```text
                     ┌──────────────────┐
                     │   React Client   │
                     │  TypeScript/Vite │
                     └─────────┬────────┘
                               │
                        REST API + SSE
                               │
                     ┌─────────▼────────┐        ┌────────────────┐
                     │    Node.js API   │───────▶│ Model provider │
                     │TypeScript/Express│        │ Ollama, or any │
                     └──┬────────┬────┬─┘        │ OpenAI-compat. │
                        │        │    │          └────────────────┘
       ┌────────────────┘        │    └─────────────┐
       │                         │                  │
┌──────▼───────┐         ┌───────▼──────┐   ┌───────▼──────┐
│  Prisma ORM  │         │    Redis     │   │ Disk  or  S3 │
└──────┬───────┘         │  sessions,   │   │uploaded files│
       │                 │ rate limits, │   └──────────────┘
┌──────▼───────┐         │  AI budgets  │
│  PostgreSQL  │         └──────────────┘
└──────────────┘
```

Inside the API the layering is strict, and the backlog's house rules hold every
task to it:

```text
routes/<name>.ts      thin: auth, Zod validation, status codes
services/<name>.ts    all logic, all database access
lib/                  cross-cutting seams: storage, jwt, redis, rate-limit,
                      image, media, mailer, one-time-token
middleware/           authenticate, current-user, error-handler
```

The `services/ai/` module sits beside those with the same discipline: one
provider interface, one place a client is constructed, and a missing model
server answers 503 instead of crashing the app — the whole API boots and serves
every non-AI route on a machine that has never heard of a model.
`docs/ai-architecture.md` traces a request through it.

## 🛠️ Tech Stack

### Frontend

- React 19
- TypeScript 6
- Vite 8
- React Router 7
- Hand-written CSS (design tokens in `index.css`, no UI framework)
- `fetch` through a single client that handles the access token and refresh,
  plus a separate reader for the SSE stream — `request()` always ends in
  `response.json()`, so streaming cannot go through it

### Backend

- Node.js 22
- TypeScript 6
- Express 5
- Prisma ORM 8 (`@prisma/orm-postgres`)
- Zod 4
- jsonwebtoken
- argon2
- pino / pino-http
- google-auth-library
- `@aws-sdk/client-s3` + `lib-storage` (only reached when `S3_BUCKET` is set)
- No model-provider SDK: the providers are called over plain `fetch`

### Database & infrastructure

- PostgreSQL 17
- Redis 8
- Docker & Docker Compose
- Ollama (optional, for local models), or any OpenAI-compatible host
- Any S3-compatible object store for uploads (optional; Cloudflare R2 is the
  cheapest way in)
- Render, for the deployed instance — see `docs/DEPLOYMENT.md` and
  `render.yaml`

### Development

- pnpm workspaces + Turborepo
- ESLint, Prettier
- Vitest
- Git & GitHub

## 📁 Project Structure

```text
scribe/
├── apps/
│   ├── api/                  # Node.js + Express + Prisma API
│   │   ├── src/
│   │   │   ├── routes/       # one thin router per resource (+ its tests)
│   │   │   ├── services/     # all logic and data access
│   │   │   │   └── ai/       # provider seam, Scribble, prompts, streaming
│   │   │   ├── lib/          # storage, jwt, redis, rate-limit, image, media,
│   │   │   │                 # mailer, one-time-token, slug…
│   │   │   ├── middleware/
│   │   │   ├── prisma/       # contract.prisma + generated contract types
│   │   │   ├── scripts/      # seed-books, seed-stories, seed-challenges, grant-admin
│   │   │   ├── test/         # TestApi harness
│   │   │   ├── app.ts
│   │   │   └── server.ts
│   │   ├── migrations/app/   # checked-in SQL migrations
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   └── web/                  # React + Vite client
│       ├── src/
│       │   ├── pages/        # incl. pages/author (the author studio)
│       │   ├── components/   # layout, ui, story, books, charts, ai, settings
│       │   ├── data/         # *-api.ts (real) + api.ts/mock-db.ts (onboarding)
│       │   ├── hooks/  lib/  types/
│       │   └── index.css
│       ├── Dockerfile
│       ├── nginx.conf
│       └── package.json
│
├── docs/                     # BACKLOG, AI-BACKLOG, ai-architecture,
│                             # content-model, DEPLOYMENT
├── docker-compose.yml        # Development stack
├── docker-compose.prod.yml   # Production-style stack
├── render.yaml               # The deployed stack, as a Render blueprint
├── .env.example              # Root env, for the production-style stack only
├── turbo.json
├── pnpm-workspace.yaml
└── README.md
```

## 🚀 Getting Started

The whole stack — Postgres, Redis, the API and the web app — runs in Docker.
Nothing but Docker and Git is required on the host.

### Prerequisites

- Docker 24+ with the Compose v2 plugin
- Git
- Node.js 22+ and pnpm 10+ _(only if you want to run the apps on the host
  instead of in containers)_

### 1. Clone the repository

```bash
git clone <your-repository-url>
cd scribe
```

### 2. Configure environment variables

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
```

Fill in `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` — the API refuses to
start without them:

```bash
openssl rand -base64 48
```

`GOOGLE_CLIENT_ID` (API) and `VITE_GOOGLE_CLIENT_ID` (web) must be the _same_
OAuth client id; leave both blank to run without Google sign-in.

Compose overrides `DATABASE_URL`, `REDIS_URL`, `AI_BASE_URL` and
`VITE_API_PROXY_TARGET` so the containers reach each other by service name. The
values in your `.env` files point at published host ports, which is what the
apps need when you run them outside Docker.

Everything else in `apps/api/.env.example` is optional and commented out, with
a default that describes the free local stack:

| Block                                           | Default without it                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Email (`MAIL_TRANSPORT`, `WEB_APP_URL`)         | Messages are printed to the API log — the log _is_ the inbox, links included                           |
| AI (`AI_PROVIDER`, `AI_MODEL`, `AI_API_KEY`, …) | Ollama on `localhost:11434`; with no server running, the AI routes answer 503 and nothing else changes |
| Uploads (`S3_*`, `PUBLIC_UPLOAD_BASE_URL`)      | The local filesystem under `UPLOAD_DIR`, served from `/uploads`                                        |

### 3. Start the stack

```bash
docker compose up -d --build
```

### 4. Apply database migrations

```bash
docker compose run --rm api-migrate
```

### 5. Optional: seed sample content

```bash
docker compose exec api pnpm --filter api seed:books       # catalogue books + a demo reader
docker compose exec api pnpm --filter api seed:stories     # Scribe stories with chapters
docker compose exec api pnpm --filter api seed:challenges  # writing challenges, past and upcoming
```

Writing challenges can only be created by an administrator, and no endpoint
grants that flag — so it is set against the database:

```bash
docker compose exec api pnpm --filter api admin:grant <username>
docker compose exec api pnpm --filter api admin:grant <username> --revoke
```

| Service    | URL                                               |
| ---------- | ------------------------------------------------- |
| Web app    | http://localhost:1302                             |
| API        | http://localhost:1303                             |
| Health     | http://localhost:1303/health                      |
| PostgreSQL | localhost:1301                                    |
| Redis      | localhost:1304                                    |
| Ollama     | http://localhost:11434 _(opt-in, `--profile ai`)_ |

`apps/api` and `apps/web` are bind-mounted into their containers, so `tsx
watch` and Vite HMR pick up host edits without a rebuild. Rebuild only when
dependencies change:

```bash
docker compose up -d --build
```

### Running the apps on the host instead

The dependencies are still worth running in Docker:

```bash
docker compose up -d postgres redis
pnpm install
pnpm dev
```

Turborepo drives the workspace scripts: `pnpm dev`, `pnpm build`,
`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm format`.

## 🐳 Docker

### Development

```bash
docker compose up -d --build         # start everything
docker compose logs -f api           # follow one service
docker compose exec api sh           # shell into a container
docker compose down                  # stop, keeping data
docker compose down -v               # stop and delete the volumes
```

### Optional: a local model server

Opt-in, because the image plus weights run to several GB. Nothing else needs
it: with no model server the app starts normally and only the AI routes answer 503.

```bash
docker compose --profile ai up -d ollama
docker compose exec ollama ollama pull llama3.2:3b       # ~2 GB
docker compose exec ollama ollama pull nomic-embed-text  # ~275 MB
```

### Production-style

`docker-compose.prod.yml` builds the same code as release images: the API
compiled to `dist/` with dev dependencies pruned, and the web bundle served by
nginx, which also proxies `/api` to the API. Neither app is bind-mounted and
no port but nginx's is published.

```bash
cp .env.example .env                 # root .env, used by this stack only
# fill in POSTGRES_PASSWORD, JWT_ACCESS_SECRET, JWT_REFRESH_SECRET
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml run --rm api-migrate
```

The app is then served on `WEB_PORT` (8080 by default). Secrets have no
defaults on purpose: an unset one aborts `docker compose` with the name of the
variable rather than starting the stack with a known value.

### Images

| Image                 | Stages                                                             |
| --------------------- | ------------------------------------------------------------------ |
| `apps/api/Dockerfile` | `dev` (tsx watch) · `runtime` (compiled, non-root, health-checked) |
| `apps/web/Dockerfile` | `dev` (Vite + HMR) · `runtime` (static bundle behind nginx)        |

Both build from the repository root — the pnpm lockfile and workspace manifest
live there — and install with `--frozen-lockfile` so an image never silently
resolves a different dependency tree than your machine.

## ☁️ Deployment

A live instance runs on Render's free tier: the
[web app](https://scribe-web-7mpz.onrender.com) as a Static Site, the
[API](https://scribe-new.onrender.com/health) as a Web Service built from the
same `apps/api/Dockerfile` as everything else, Redis as a Key Value add-on, and
Postgres on Neon — external because Render deletes a free Postgres database
after 30 days.
`docs/DEPLOYMENT.md` walks the whole thing service by service; `render.yaml` is
the same list as a blueprint, and is the authoritative record of the settings
and environment variables.

Three constraints come with the free tier:

- **The instance sleeps after 15 minutes idle**, so the first request after a
  quiet spell waits out a ~50s cold start.
- **No disk can be mounted**, so `UPLOAD_DIR` is wiped on every deploy and
  every spin-down. Setting `S3_BUCKET` moves covers, avatars and chapter media
  to an S3-compatible object store instead; `GET /health` reports which backend
  is live, because from outside the two look identical until a file vanishes.
- **No model server of its own**, so `AI_PROVIDER=openai` against any host
  speaking the OpenAI chat-completions format — the provider seam was built so
  this is an environment variable and not a code change.

## 🔌 API

Everything below is implemented and covered by tests unless noted. All paths
are prefixed with `/api`.

### Authentication — `routes/auth.ts`

The refresh token travels as an httpOnly cookie and rotates on every use; the
live token for a session lives in Redis, so sessions are revocable.

```text
POST /api/auth/signup
POST /api/auth/login
POST /api/auth/refresh
POST /api/auth/logout
POST /api/auth/logout-all
POST /api/auth/google       # a Google ID token, verified server-side
```

### Passwords & email verification — `routes/auth-security.ts`

A second router on `/api/auth`, split out to keep `auth.ts` readable. It lives
under that prefix rather than `/api/account` for two reasons: the refresh
cookie is scoped to `/api/auth`, so this is where a route can rotate the
caller's session, and four of the six endpoints are reachable _without_ one.

```text
POST /api/auth/forgot-password    # always the same answer, account or not
POST /api/auth/reset-password     # a one-time token; revokes every session
POST /api/auth/change-password    # signed in, needs the current password
POST /api/auth/set-password       # signed in via Google, no password yet
POST /api/auth/send-verification
POST /api/auth/verify-email
```

Tokens are opaque, single-use and held in Redis (`lib/one-time-token.ts`), so
they expire on their own and a used one cannot be replayed. `forgot-password`
answers identically whether or not the address has an account — the service
never reports which, so nothing downstream can start branching on it — and
`reset-password` issues no session: the caller signs in with the new password,
which also confirms they remember it.

Mail goes through `lib/mailer.ts`, whose default transport _prints_ the message
to the API log. A fresh clone runs both flows end to end with no credentials
and no account anywhere: the link is in the log.

### Account — `routes/account.ts`

```text
GET    /api/account/me
PATCH  /api/account/me      # displayName, username, email, bio
DELETE /api/account/me      # confirmation in the body, never the query string
POST   /api/account/avatar  # the image bytes as the request body
DELETE /api/account/avatar
```

### Public profiles & follows — `routes/users.ts`

What anybody may see about anybody, as against `/api/account` above, which
serves the caller _their own_ account. A profile is written out field by field
in `services/users.ts`, so `email`, `passwordHash` and `googleId` have no path
out — a test pins the exact key set.

```text
GET    /api/users/:username             # profile + the caller's follow state
GET    /api/users/:username/stories     # their stories, paginated, newest first
GET    /api/users/:username/followers
GET    /api/users/:username/following
POST   /api/users/:username/follow      # idempotent, rate-limited, no self-follow
DELETE /api/users/:username/follow      # idempotent
```

Reading is public; the two writes need a signed-in user. Follower counts are
computed from `engagement.Follow` on every read rather than denormalised:
nothing sorts or filters on one, so a column would only be something that can
drift. `storyCount` and the story list share `listStories`' visibility rule, so
the profile header cannot disagree with the Stories tab — including for an
author looking at their own drafts.

### Uploads — `routes/uploads.ts`

```text
POST /api/uploads?kind=cover   # an image, as the request body
POST /api/uploads?kind=media   # chapter audio or video, as the request body
```

The file is the raw request body rather than multipart: one file needs no
envelope, and this way there is no multipart parser to configure or keep safe.
What the bytes _are_ is decided by sniffing the signature (`lib/image.ts`,
`lib/media.ts`), never by the declared `Content-Type` or the file name.

Images are buffered and capped at 5 MB. Audio and video are **not** — a video
at the 128 MB media cap would be more memory than the process should spend on
one request — so those requests are left unparsed and streamed straight to
storage, and a stream aborted at the cap leaves no partial file behind. Both
kinds are rate-limited per user.

The upload and the row that references it are two steps: this returns a URL,
and the caller saves it (`PATCH /api/author/stories/:id` with `coverUrl`,
`POST /api/author/chapters/:id/multimedia` with the media URL).

Files are written by `apps/api/src/lib/storage.ts`: the local filesystem by
default, served from `/uploads/...` — set `UPLOAD_DIR` to choose where they
land and `PUBLIC_UPLOAD_BASE_URL` when the API is on another host — or any
S3-compatible object store when `S3_BUCKET` and `S3_PUBLIC_BASE_URL` are set.
A host with no persistent disk wants the object store: a free Render instance
wipes the local directory on every deploy and every spin-down.

### Books (the catalogue) — `routes/books.ts`

```text
GET /api/books/genres
GET /api/books/discover
GET /api/books                 # search, genre and sort filters, paginated
GET /api/books/:id
GET /api/books/:id/related
```

### Library — `routes/library.ts`

```text
GET    /api/library
POST   /api/library
PATCH  /api/library/:bookId
DELETE /api/library/:bookId
```

### Stories & chapters, public — `routes/stories.ts`

Drafts and unpublished chapters are visible to their author only.

```text
GET /api/stories/genres
GET /api/stories
GET /api/stories/:slug
GET /api/stories/:slug/related
GET /api/stories/:slug/chapters
GET /api/stories/:slug/chapters/:number
```

### Reading progress & streak — `routes/reading.ts`

A position belongs to a reader, so the whole router is behind `requireUser`
and every handler reads the id back from `res.locals` rather than from the
body.

```text
PUT    /api/reading/progress            # storyId, chapterId, offset
GET    /api/reading/continue            # where to pick each story back up
GET    /api/reading/progress/:storyId
DELETE /api/reading/progress/:storyId
```

`offset` is unbounded in the schema on purpose: the service clamps it to the
chapter's real length, which only the service knows. Saving progress also
advances the reading streak and returns it, so the UI reflects it at once. A
missed day resets the streak rather than inflating one, and a same-day save
changes nothing.

### Author studio — `routes/authoring.ts`

Every route requires a signed-in user and checks ownership.

```text
GET    /api/author/stories
POST   /api/author/stories
PATCH  /api/author/stories/:id
DELETE /api/author/stories/:id
POST   /api/author/stories/:id/publish
POST   /api/author/stories/:id/unpublish

GET    /api/author/stories/:id/chapters
POST   /api/author/stories/:id/chapters
POST   /api/author/stories/:id/chapters/reorder
PATCH  /api/author/chapters/:id
DELETE /api/author/chapters/:id
POST   /api/author/chapters/:id/publish
POST   /api/author/chapters/:id/unpublish

POST   /api/author/chapters/:id/multimedia   # takes a URL, not a file
DELETE /api/author/multimedia/:id
```

### Comments & ratings — `routes/engagement.ts`

Reading is public; writing needs a signed-in user. Mounted at `/api` rather
than under the stories router, because the paths span both `/api/stories/:id/…`
and `/api/comments/:id`.

```text
GET    /api/stories/:storyId/comments   # ?parentId lists a thread's replies,
                                        # ?chapterId narrows to one chapter
POST   /api/stories/:storyId/comments   # 1–2000 chars, trimmed, rate-limited
DELETE /api/comments/:id                # the comment's author only

GET    /api/stories/:storyId/ratings    # average, count, 1–5 breakdown, mine
PUT    /api/stories/:storyId/rating     # upsert a whole-star 1–5 score
DELETE /api/stories/:storyId/rating
```

Comments are one table for threads and replies, capped at one level deep — the
same shape as a club's discussions. `content.Story.ratingAverage` and
`ratingCount` are denormalised and recomputed inside the same transaction as
every rating write, because `sort=rating` orders in SQL over that table.

### Book clubs — `routes/clubs.ts`

Browsing is open: the list and the detail page are public, and a signed-in
caller additionally sees their own membership. Everything that writes takes
`requireUser` as route-level middleware instead.

```text
GET    /api/clubs                       # search, sort, paginated
POST   /api/clubs
GET    /api/clubs/:slug                 # + the caller's membership
PATCH  /api/clubs/:id
DELETE /api/clubs/:id

GET    /api/clubs/:slug/members
POST   /api/clubs/:id/join
DELETE /api/clubs/:id/leave
PATCH  /api/clubs/:id/members/:userId   # change a member's role
DELETE /api/clubs/:id/members/:userId   # remove a member
PUT    /api/clubs/:id/current-read      # the club's current book

GET    /api/clubs/:slug/discussions
POST   /api/clubs/:id/discussions       # ?parentId for a reply
DELETE /api/clubs/discussions/:id
```

### Broadcast channels — `routes/channels.ts`

Reading is open; posting is the channel owner's. Same shape as clubs above.

```text
GET    /api/channels
POST   /api/channels
GET    /api/channels/:slug
PATCH  /api/channels/:id
DELETE /api/channels/:id

POST   /api/channels/:id/subscribe
DELETE /api/channels/:id/subscribe

GET    /api/channels/:slug/posts
POST   /api/channels/:id/posts
PATCH  /api/channels/posts/:id
DELETE /api/channels/posts/:id
```

Clubs' discussions, channels' posts and stories' comments are three spellings
of one thing, and they are implemented as one: a `Page<T>` of
`{ items, page, limit, total, totalPages, hasMore }` newest-first with `id` as
the tie-breaker, an author summary of exactly
`{ id, username, displayName, avatarUrl }`, one table for threads and replies
capped at one level deep, a create rate-limited per _user_ and charged only
after the write succeeds, and a delete that is author-or-moderator. Three
independent implementations would give content moderation three read paths to
audit, which is exactly where that kind of bug hides.

### Writing challenges — `routes/challenges.ts`

Browsing is public; entering needs a signed-in user, and hosting needs an
administrator (`auth.User.isAdmin`, granted by `admin:grant` above and read in
one place, `services/roles.ts`).

```text
GET    /api/challenges                  # active, upcoming and past, in one response
GET    /api/challenges/:slug            # detail + the caller's own entry
GET    /api/challenges/:slug/leaderboard

POST   /api/challenges/:id/enter        # take a place; 409 outside the window or twice
PUT    /api/challenges/entries/:id      # attach, swap or clear the story; edit the note
DELETE /api/challenges/entries/:id      # withdraw, while the window is open

POST   /api/challenges                  # administrators only
PATCH  /api/challenges/:id              # administrators only
```

A challenge's state — `upcoming`, `active`, `past` — is derived from its date
window rather than stored, so nothing can be left stale by a job that did not
run. Entering and submitting are separate steps, which is why a place can exist
with no story on it and why "participants" and "entries" are different numbers.
The leaderboard ranks in SQL by the **sum of the star ratings each entry's
story has earned** — there is no ballot in the contract, and `RANKING` in
`services/challenges.ts` is the one place that rule lives. Only published
stories are ranked, and the board is built anonymously so every viewer sees the
same order.

### Author analytics — `routes/analytics.ts`

Mounted on `/api/author` beside the authoring router and behind `requireUser`
in full. Neither call takes an author id: there is no such thing as somebody
else's analytics, so the API answers for whoever is asking.

```text
GET /api/author/analytics?range=7d|30d|90d         # totals, lifetime, series, per story
GET /api/author/analytics/stories/:id?range=…      # one story + its chapter breakdown
```

Two event tables record the traffic — `engagement.StoryView` and
`engagement.ChapterRead` — written from the public story and chapter endpoints,
**deduped to one row per visitor per target per UTC day** by a unique key and
an `ON CONFLICT DO NOTHING`, so a refresh cannot inflate anything and there is
no read-then-write to race. The recording calls return `void` by design: a
handler cannot await one, and a counter's failure can never slow or fail a
reader's request. An author's visits to their own story are excluded in the
same statement. Signed-out readers are counted through a digest of address and
user agent salted with the day, so they are one visitor for a day and nobody in
particular tomorrow.

Everything is aggregated in SQL, with `generate_series` supplying the days so a
range always has exactly as many points as it has days — a story with no
traffic is a run of zeroes, not a gap. `content.Story.viewCount` stays the
lifetime counter (`sort=views` orders on it) and is moved by the same statement
that writes the event.

### Badges & levels — `routes/gamification.ts`

Mounted at the root, because its two paths sit under different prefixes: one
is the caller's own collection, the other is somebody else's.

```text
GET /api/badges                    # the catalogue + the caller's progress
GET /api/users/:username/badges    # what that user has earned
```

A badge is one row in `BADGES` (`services/gamification.ts`) naming a metric and
the number that earns it; the metrics are counted in SQL. Levels are a pure
function of one metric against a ladder — a reader ladder and an author one —
recomputed from scratch on every evaluation rather than stored, so nothing can
be left stale.

### Notifications — `routes/notifications.ts`

```text
GET  /api/notifications                # paginated, newest first, + unread count
GET  /api/notifications?unread=true    # narrows the list; the count stays whole
POST /api/notifications/:id/read       # answers the new unread count
POST /api/notifications/read-all
```

Five things are announced: a new post in a channel you subscribe to, a reply to
your comment or club thread, a new thread in a club you belong to, a story newly
listed by an author you follow, and a badge you earned. Services call a single
`notify()` in `services/notifications.ts` after the write they are reporting;
routes never insert a notification themselves.

Fan-out is one `INSERT ... SELECT` per event whose `SELECT` *is* the audience,
so a channel with ten thousand subscribers is one statement and no array in the
API's memory — and the actor is excluded by the same `WHERE`, which is what
makes "never notify somebody about their own action" a property of the query
rather than a filter somebody has to remember. Like analytics events and badge
awards, it is fire-and-forget: `notify()` returns `void` so no handler can wait
on it, and a failed fan-out can never fail the write it followed.

The bell polls on an interval for now. Everything that knows that is `subscribe`
in `apps/web/src/hooks/useNotifications.ts`, which takes a callback and returns
a teardown — the contract an `EventSource` or a websocket already has — so
moving to push is rewriting that one function.

### Scribble (GenAI) — `routes/ai.ts`

```text
POST /api/ai/scribble          # JSON: intro, recommendations, the filters used
POST /api/ai/scribble/stream   # the same answer as Server-Sent Events
```

Both are behind `requireUser` and rate-limited without exception — generation
costs CPU on this machine and money on a hosted provider, and an
unauthenticated AI endpoint is an open wallet either way. The limit is tighter
than the auth router's, because one model call occupies a core for seconds.

Two routes rather than a flag, because they are different contracts: the JSON
one retries transient provider failures and the streaming one deliberately does
not. The stream is SSE over POST, so it cannot be an `EventSource`; the client
reads the body itself. Headers are not flushed until the first event — every
provider-availability failure is raised before then, and writing
`200 text/event-stream` early would turn a real 503 into a fake success
carrying an error frame.

With no model server configured or reachable, these two answer 503 and nothing
else in the API changes. `docs/ai-architecture.md` has the status table.

### Health

```text
GET /health
```

Answers with the selected AI provider and whether its credential is present —
no key, no URL — and with the storage backend and the host it serves from. Both
are things a deployment can get wrong invisibly: an object store and the
instance's own disk are indistinguishable from outside until a file vanishes on
the next deploy, and a deployment still defaulting to the local model provider
otherwise shows up only as a 503 that every AI failure shares.

> There is no OpenAPI document yet; the routers and their tests are the
> contract. Endpoints may still change.

## 🗄️ Database

Scribe uses **PostgreSQL** as its only datastore for application data, with
Redis alongside it for refresh sessions, rate-limit windows, one-time email
tokens and AI budgets — state that is allowed to expire. Losing Redis signs
everyone out and forgets some counters; it loses no content.

Prisma provides schema management, type-safe queries and migrations. The schema
lives in `apps/api/src/prisma/contract.prisma`, organised into namespaces
(`auth`, `content`, `engagement`, `gamification`, `challenges`, `clubs`,
`channels`, `library`, `notifications`); generated types land in
`src/prisma/contract.d.ts` via `pnpm --filter api contract:emit`, and every
schema change is accompanied by a checked-in migration under
`apps/api/migrations/app/`.

There is one work entity — `content.Story`. Catalogue books are `Story` rows
with an `isbn` and no chapters, which is why every social feature attaches to a
single model instead of two. `docs/content-model.md` records that decision.

## 🧪 Testing

Integration tests run the real Express app against a real database through
`TestApi` (`apps/api/src/test/harness.ts`), which tracks what a test created
and tears it down afterwards.

```bash
pnpm test                            # every workspace package
docker compose exec api pnpm --filter api test
docker compose exec api pnpm --filter api test routes/authoring
```

Covered today, across 24 suites: auth (incl. Google and the password/email
flows), account, books, library, stories, authoring, uploads, storage, reading
progress, clubs, channels, comments + ratings, public profiles + follows,
writing challenges, author analytics, badges and notifications, plus Scribble,
the AI provider seam and its streaming JSON scanner.

No test calls a real model provider — a fake one lives in
`services/ai/testing.ts` — and none writes to a real object store: the Vitest
config forces `S3_BUCKET` empty so a developer with credentials in
`apps/api/.env` does not have the suite upload to a live bucket.

The web app has no test suite yet.

## 📌 Development Roadmap

### Phase 1 — Foundation

- [x] Project setup (pnpm workspaces + Turborepo)
- [x] Docker development environment
- [x] PostgreSQL + Redis
- [x] Prisma configuration and migrations
- [x] API health check
- [x] Centralized error handling
- [x] Structured logging

### Phase 2 — Authentication

- [x] User signup
- [x] Login
- [x] JWT authentication
- [x] Refresh-token rotation and revocable sessions
- [x] Logout / logout-all
- [x] Google sign-in
- [x] Password reset & email verification
- [x] Account deletion
- [x] Role-based authorization (`auth.User.isAdmin`, read only in `services/roles.ts`)

### Phase 3 — Core Platform

- [x] Catalogue browsing and filtering
- [x] Personal library
- [x] Story management
- [x] Chapter management
- [x] Genres
- [x] Draft and publishing workflow
- [x] Reader experience (story detail, chapter reader)
- [x] Image uploads (covers, avatars)
- [x] Audio/video uploads for chapter multimedia
- [x] Public author profiles

### Phase 4 — Social Features

- [x] Comments
- [x] Ratings
- [x] Reading history & progress
- [x] Follows
- [ ] Notifications

### Phase 5 — Platform Features

- [x] Search and filtering
- [ ] Real recommendations (mock today)
- [x] Author analytics on real data
- [ ] Content moderation & reporting
- [x] Badges and levels
- [x] Writing challenges
- [x] Book clubs
- [x] Broadcast channels
- [ ] Retire the mock data layer

### Phase 6 — GenAI (`docs/AI-BACKLOG.md`)

- [x] AI 0 — provider seam, config, retry/usage policy, fake provider
- [x] AI 1.5 — Scribble, the discovery concierge
- [x] AI 2 — streaming (SSE), landed with Scribble
- [ ] Conversation memory, so a follow-up resolves against the last answer
      (AI 10)
- [ ] Enforcing the per-user daily token budget, which is read but not yet
      applied (AI 18)
- [ ] The rest — embeddings, semantic search, RAG, moderation, evaluation

### Phase 7 — Production Readiness

- [x] Production-style Docker setup
- [x] Deployed (Render free tier — see `docs/DEPLOYMENT.md`)
- [x] Durable uploads off the instance's disk (S3-compatible object store)
- [x] Integration test coverage on the API
- [ ] Frontend tests
- [ ] API documentation (OpenAPI)
- [ ] CI/CD
- [ ] Performance optimization
- [ ] Security hardening review
- [ ] Monitoring

## 🎯 Project Goals

Scribe is being developed with a focus on:

- Clean and maintainable architecture, with one obvious place for each concern
- Type-safe development end to end
- Secure authentication and authorization
- Scalable API design
- Relational database design
- Containerized development
- Automated testing
- Comments that explain _why_, not _what_

## 📄 License

This project is currently for personal learning and portfolio development.
