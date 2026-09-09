# Scribe

**Scribe** is a full-stack social reading and story publishing platform where readers can discover and read stories, while writers can create, manage, and publish their own content.

The project is being rebuilt with a modern, production-oriented architecture using **React, Node.js, TypeScript, PostgreSQL, Prisma, and Docker**.

## ✨ Features

### 📖 Readers

- Browse and discover stories
- Filter stories by genre
- Read stories and chapters
- Track reading progress
- Save stories for later
- Like, rate, and comment on stories

### ✍️ Writers

- Create and manage stories
- Write and edit chapters
- Save stories as drafts
- Publish completed chapters
- Manage story information, genres, and covers
- View basic story analytics

### 🔐 Authentication & Authorization

- User registration and login
- JWT-based authentication
- Access and refresh tokens
- Protected API routes
- Role-based authorization
- Secure password hashing

### 🛡️ Platform

- Input validation
- Centralized error handling
- API pagination
- Search and filtering
- Database migrations
- API documentation
- Dockerized development environment

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
                    │ TypeScript/Express│
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │      Prisma      │
                    │       ORM        │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │   PostgreSQL     │
                    └──────────────────┘
```

## 🛠️ Tech Stack

### Frontend

- React
- TypeScript
- Vite
- Tailwind CSS
- React Router
- Axios

### Backend

- Node.js
- TypeScript
- Express
- Prisma
- Zod
- JWT
- bcrypt

### Database & Infrastructure

- PostgreSQL
- Docker
- Docker Compose

### Development

- ESLint
- Prettier
- Jest
- Swagger / OpenAPI
- Git & GitHub

## 📁 Project Structure

```text
scribe/
├── apps/
│   ├── api/                  # Node.js + Express + Prisma API
│   │   ├── src/
│   │   ├── migrations/
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   └── web/                  # React + Vite client
│       ├── src/
│       ├── public/
│       ├── Dockerfile
│       ├── nginx.conf
│       └── package.json
│
├── packages/                 # Shared workspace packages
├── docker-compose.yml        # Development stack
├── docker-compose.prod.yml   # Production-style stack
├── .env.example
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

Compose overrides `DATABASE_URL`, `REDIS_URL` and `VITE_API_PROXY_TARGET` so
the containers reach each other by service name. The values in your `.env`
files point at published host ports, which is what the apps need when you run
them outside Docker.

### 3. Start the stack

```bash
docker compose up -d --build
```

### 4. Apply database migrations

```bash
docker compose run --rm api-migrate
```

### 5. Optional: seed sample books

```bash
docker compose exec api pnpm --filter api seed:books
```

| Service    | URL                          |
| ---------- | ---------------------------- |
| Web app    | http://localhost:1302        |
| API        | http://localhost:1303        |
| Health     | http://localhost:1303/health |
| PostgreSQL | localhost:1301               |
| Redis      | localhost:1304               |

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

## 🐳 Docker

### Development

```bash
docker compose up -d --build         # start everything
docker compose logs -f api           # follow one service
docker compose exec api sh           # shell into a container
docker compose down                  # stop, keeping data
docker compose down -v               # stop and delete the volumes
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

The backend exposes a REST API.

### Authentication

```text
POST /api/auth/register
POST /api/auth/login
POST /api/auth/refresh
POST /api/auth/logout
```

### Users

```text
GET /api/user
GET /api/users/:id
```

### Stories

```text
POST   /api/stories
GET    /api/stories
GET    /api/stories/:id
PATCH  /api/stories/:id
DELETE /api/stories/:id
```

### Chapters

```text
POST   /api/stories/:storyId/chapters
GET    /api/stories/:storyId/chapters
GET    /api/chapters/:id
PATCH  /api/chapters/:id
DELETE /api/chapters/:id
```

> API endpoints may evolve as the project develops.

## 🗄️ Database

Scribe uses **PostgreSQL** as its primary relational database.

Prisma is used for:

- Schema management
- Type-safe database queries
- Database migrations
- Seeding development data

The goal is to keep the application's core data in a single relational database rather than splitting related functionality across multiple database systems.

## 🧪 Testing

```bash
pnpm test                            # every workspace package
docker compose exec api pnpm --filter api test
```

## 📌 Development Roadmap

### Phase 1 — Foundation

- [x] Project setup
- [x] Docker development environment
- [x] PostgreSQL setup
- [ ] Prisma configuration
- [ ] API health check
- [ ] Error handling
- [ ] Logging

### Phase 2 — Authentication

- [ ] User registration
- [ ] Login
- [ ] JWT authentication
- [ ] Refresh tokens
- [ ] Logout
- [ ] Role-based authorization

### Phase 3 — Core Platform

- [ ] Story management
- [ ] Chapter management
- [ ] Genres
- [ ] Draft and publishing workflow
- [ ] Reader experience
- [ ] Author profiles

### Phase 4 — Social Features

- [ ] Likes
- [ ] Comments
- [ ] Ratings
- [ ] Bookmarks
- [ ] Reading history
- [ ] Reading progress

### Phase 5 — Platform Features

- [ ] Search
- [ ] Recommendations
- [ ] Author analytics
- [ ] Content moderation
- [ ] Badges and achievements
- [ ] Writing challenges
- [ ] Book clubs

### Phase 6 — Production Readiness

- [ ] Comprehensive test coverage
- [ ] API documentation
- [ ] CI/CD
- [ ] Production Docker setup
- [ ] Performance optimization
- [ ] Security hardening
- [ ] Monitoring and logging

## 🎯 Project Goals

Scribe is being developed with a focus on:

- Clean and maintainable architecture
- Type-safe development
- Secure authentication and authorization
- Scalable API design
- Relational database design
- Containerized development
- Automated testing
- Production-ready engineering practices

## 📄 License

This project is currently for personal learning and portfolio development.
