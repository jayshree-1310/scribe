# Scribe

**Scribe** is a full-stack social reading and story publishing platform: readers
discover, read and shelve stories; authors write, publish and manage them.

The project is a rebuild with a production-oriented architecture — **React,
Node.js, TypeScript, PostgreSQL, Prisma and Docker** — and is under active
development. The frontend is complete as a design surface; the backend is being
filled in behind it, page by page, replacing an in-repo mock layer. The section
[Where the project actually stands](#-where-the-project-actually-stands) says
which parts are real today.

## 📍 Where the project actually stands

| Area                                                                           | State                                                                       |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Auth — email signup/login, refresh rotation, logout, Google sign-in            | **Real API**                                                                |
| Account — profile edits, avatar upload                                         | **Real API**                                                                |
| Catalogue books — discover, filter, detail, related                            | **Real API**                                                                |
| My Library — shelve, update, remove                                            | **Real API**                                                                |
| Stories & chapters — public reading                                            | **Real API**                                                                |
| Author studio — stories, chapters, reorder, publish/unpublish, multimedia rows | **Real API**                                                                |
| Image uploads (`kind=cover`)                                                   | **Real API**                                                                |
| Home feed, profiles, onboarding, badges, clubs, channels, challenges           | **Mock** (`apps/web/src/data/api.ts` + `mock-db.ts`)                        |
| Comments, ratings, reading progress, notifications, moderation                 | Not built — see `docs/BACKLOG.md`                                           |
| GenAI features                                                                 | Provider seam only — see `docs/AI-BACKLOG.md` and `docs/ai-architecture.md` |

Two planning documents drive the work, and both are grounded in the current
tree rather than in the abstract:

- `docs/BACKLOG.md` — the gap between the frontend surface and the API, as
  self-contained tasks.
- `docs/AI-BACKLOG.md` — the GenAI roadmap (AI 0 – AI 20). AI 0 has landed.
- `docs/content-model.md` — why there is one work entity (`content.Story`)
  rather than separate `Book` and `Story` models.

## ✨ Features

### 📖 Readers

- Browse and discover stories and catalogue books, filtered by genre
- Read stories chapter by chapter
- Shelve stories in a personal library with a status per shelf item
- Related-title suggestions

### ✍️ Authors

- Create and manage stories, with genres, cover and description
- Write chapters in a markdown editor with live preview and autosave
- Reorder chapters; publish or unpublish either a story or a single chapter
- Attach multimedia rows to a chapter
- A dashboard and analytics view (analytics still reads mock numbers)

### 🔐 Authentication & authorization

- Email/password signup and login, with Argon2id password hashing
- Google sign-in (ID-token verification against a shared OAuth client id)
- Short-lived JWT access tokens; refresh tokens rotated and tracked in Redis,
  so a stolen refresh token can be revoked
- `logout` and `logout-all` (every session for the user)
- Per-IP, per-scope rate limiting on the auth routes
- Ownership checks on every authoring mutation

### 🛡️ Platform

- Every `query` / `body` / `params` validated with Zod before it reaches logic
- Centralized `HttpError` with a closed `ErrorCode` union, one error handler
- Structured request logging (pino), `helmet`, configurable CORS
- Cursor/offset pagination, search and filtering on the list endpoints
- Local-filesystem file storage behind a one-method interface, with content
  sniffing rather than trust in the declared MIME type
- SQL migrations checked into the repo
- Integration tests against a real database
- Fully dockerized development environment

## 🏗️ Architecture

```text
                    ┌──────────────────┐
                    │   React Client   │
                    │  TypeScript/Vite │
                    └────────┬─────────┘
                             │
                           REST API
                             │
                    ┌────────▼─────────┐
                    │   Node.js API    │
                    │TypeScript/Express│
                    └───┬─────────┬────┘
                        │         │
              ┌─────────▼──┐   ┌──▼──────────┐
              │   Prisma   │   │    Redis    │
              │    ORM     │   │ sessions,   │
              └─────────┬──┘   │ rate limits │
                        │      └─────────────┘
               ┌────────▼─────────┐
               │   PostgreSQL     │
               └──────────────────┘
```

Inside the API the layering is strict, and the backlog's house rules hold every
task to it:

```text
routes/<name>.ts      thin: auth, Zod validation, status codes
services/<name>.ts    all logic, all database access
lib/                  cross-cutting seams: storage, jwt, redis, rate-limit, image
middleware/           authenticate, current-user, error-handler
```

An optional `services/ai/` module sits beside those with the same discipline:
one provider interface, one place a client is constructed, and a missing model
server answers 503 instead of crashing the app. `docs/ai-architecture.md`
traces a request through it.

## 🛠️ Tech Stack

### Frontend

- React 19
- TypeScript
- Vite 8
- React Router 7
- Hand-written CSS (design tokens in `index.css`, no UI framework)
- `fetch` through a single client that handles the access token and refresh

### Backend

- Node.js 22
- TypeScript
- Express 5
- Prisma ORM 8 (`@prisma/orm-postgres`)
- Zod 4
- jsonwebtoken
- argon2
- pino / pino-http
- google-auth-library

### Database & infrastructure

- PostgreSQL 17
- Redis 8
- Docker & Docker Compose
- Ollama (optional, for local models)

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
│   │   │   │   └── ai/       # provider seam for the GenAI backlog
│   │   │   ├── lib/          # storage, jwt, redis, rate-limit, image, slug…
│   │   │   ├── middleware/
│   │   │   ├── prisma/       # contract.prisma + generated contract types
│   │   │   ├── scripts/      # seed-books, seed-stories
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
│       │   ├── components/   # layout, ui, story
│       │   ├── data/         # *-api.ts (real) + api.ts/mock-db.ts (mock)
│       │   ├── hooks/  lib/  types/
│       │   └── index.css
│       ├── Dockerfile
│       ├── nginx.conf
│       └── package.json
│
├── docs/                     # BACKLOG, AI-BACKLOG, ai-architecture, content-model
├── docker-compose.yml        # Development stack
├── docker-compose.prod.yml   # Production-style stack
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
docker compose exec api pnpm --filter api seed:books    # catalogue books + a demo reader
docker compose exec api pnpm --filter api seed:stories  # Scribe stories with chapters
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

### Account — `routes/account.ts`

```text
GET    /api/account/me
PATCH  /api/account/me      # displayName, username, email, bio
POST   /api/account/avatar  # the image bytes as the request body
DELETE /api/account/avatar
```

### Uploads — `routes/uploads.ts`

```text
POST /api/uploads?kind=cover   # the image bytes as the request body
```

Images only today (5 MB cap, per-user rate limit, signature sniffed by
`lib/image.ts`). The upload and the row that references it are two steps: this
returns a URL, and the caller saves it. Audio and video for chapter multimedia
are still outstanding — Task 7 in `docs/BACKLOG.md`.

Files are written by `apps/api/src/lib/storage.ts` and served from
`/uploads/...`; set `UPLOAD_DIR` to choose where they land, and
`PUBLIC_UPLOAD_BASE_URL` when the API is on another host.

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

### Health

```text
GET /health
```

> There is no OpenAPI document yet; the routers and their tests are the
> contract. Endpoints may still change.

## 🗄️ Database

Scribe uses **PostgreSQL** as its only datastore for application data, with
Redis alongside it for auth sessions and rate-limit windows — state that is
allowed to expire.

Prisma provides schema management, type-safe queries and migrations. The schema
lives in `apps/api/src/prisma/contract.prisma`, organised into namespaces
(`auth`, `content`, `engagement`, `gamification`, `challenges`,
`clubs`, …); generated types land in
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

Covered today: auth (incl. Google), account, books, library, stories, authoring,
uploads, reading progress, clubs, channels, and comments + ratings, plus the AI
provider seam. The web app has no test suite yet.

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
- [ ] Password reset & email verification
- [ ] Role-based authorization (ownership checks only, so far)

### Phase 3 — Core Platform

- [x] Catalogue browsing and filtering
- [x] Personal library
- [x] Story management
- [x] Chapter management
- [x] Genres
- [x] Draft and publishing workflow
- [x] Reader experience (story detail, chapter reader)
- [x] Image uploads (covers, avatars)
- [ ] Audio/video uploads for chapter multimedia
- [ ] Public author profiles

### Phase 4 — Social Features

- [x] Comments
- [x] Ratings
- [x] Reading history & progress
- [ ] Follows
- [ ] Notifications

### Phase 5 — Platform Features

- [x] Search and filtering
- [ ] Real recommendations (mock today)
- [ ] Author analytics on real data
- [ ] Content moderation & reporting
- [ ] Badges and levels
- [ ] Writing challenges
- [ ] Book clubs
- [ ] Broadcast channels
- [ ] Retire the mock data layer

### Phase 6 — GenAI (`docs/AI-BACKLOG.md`)

- [x] AI 0 — provider seam, config, retry/usage policy, fake provider
- [ ] AI 1+ — the features that use it

### Phase 7 — Production Readiness

- [x] Production-style Docker setup
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
