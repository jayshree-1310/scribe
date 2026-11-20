# Load testing

How to find out what the API can take, and what it found the first time.

The point is to fix measured bottlenecks rather than suspected ones. Every
change below was made because a number pointed at it, and each one says what
the number was before and after.

## The recipe

Everything runs against a **separate** database, `scribe_load`, so the dev
database's handful of rows stays as it is. Realistic volume matters: with 4
stories every query is fast and the test only measures Express.

```bash
cd apps/api

# 1. A database of its own, migrated like any other.
docker exec scribe-postgres psql -U scribe -d scribe -c 'create database scribe_load'
DATABASE_URL=postgresql://scribe:scribe_dev_password@localhost:1301/scribe_load \
  ./node_modules/.bin/prisma db migrate --yes

# 2. Synthetic volume (~2 minutes): 20k users, 7k stories, 60k chapters,
#    200k shelf entries, 500k views, 500k chapter reads, 300k notifications.
docker exec -i scribe-postgres psql -U scribe -d scribe_load < scripts/load-seed.sql

# 3. A production build on its own port, its own Redis database, no AI worker.
pnpm build
DOTENV_CONFIG_PATH=/dev/null NODE_ENV=production PORT=1305 \
  DATABASE_URL=postgresql://scribe:scribe_dev_password@localhost:1301/scribe_load \
  REDIS_URL=redis://localhost:1304/5 AI_JOBS=off LOG_LEVEL=warn \
  JWT_ACCESS_SECRET=load-test-access-secret-load-test-access-secret \
  JWT_REFRESH_SECRET=load-test-refresh-secret-load-test-refresh-secret \
  CORS_ORIGIN=http://localhost:1302 \
  node dist/server.js

# 4. Run it. Anonymous first, then signed in with a token minted for one of
#    the seeded users (same secrets as above).
pnpm load:test -- --base http://localhost:1305/api --concurrency 50 --duration 20
TOKEN=$(JWT_ACCESS_SECRET=load-test-access-secret-load-test-access-secret \
  node -e "import('./dist/lib/jwt.js').then(m => console.log(m.createAccessToken(process.argv[1])))" <user id>)
pnpm load:test -- --base http://localhost:1305/api --concurrency 50 --duration 20 --token "$TOKEN"
```

`load:test` (`src/scripts/load-test.ts`) is a closed loop: each virtual
reader waits for its answer before asking again. The mix is weighted towards
reading (chapter bodies, story pages), then browsing, then the signed-in
endpoints. It refuses any `--base` that is not localhost unless `--yes` is
passed.

### Finding where the time goes

- **Node CPU.** Watch `top` during a run. A process pinned at 100% means the
  API is the bottleneck. Profile with `node --cpu-prof --cpu-prof-dir=<dir>
  dist/server.js`, run the load, then send `SIGINT`.
- **Postgres.** `ALTER DATABASE scribe_load SET log_min_duration_statement = 0`
  logs every statement with its duration (new connections only, so restart
  the API). Sum by statement from `docker logs --since <start> scribe-postgres`,
  then `RESET` it, because logging slows Postgres down.

## What the first run found (2026-11-20)

These numbers are from one developer machine (8 cores, Postgres in Docker),
so they are **relative**, not a forecast for production. Render's free
instance has a fraction of one core, and Neon's free compute about a quarter
of one. Divide accordingly.

### 1. The API process is the first ceiling, not the database

With 20 or 100 concurrent readers, throughput sat at **~210–230 req/s** and
only latency grew (p50 96ms → 464ms). Node was at 100% of one core while
Postgres used about two.

The CPU profile has no hot spot in Scribe's own code (`stories.js` under 3%).
About 40% is the ORM (Prisma Next rc.8) decoding rows. Within that, the
Temporal polyfill converting timestamps is 8.5% on its own, and the rest is
mostly socket writes. Each request is cheap, but the same rows were being
decoded for every reader who asked.

Memory reached **~518 MB RSS** under load. Render's free instance has 512 MB.
Node sizes its heap to the container, so this is not proof of an OOM there,
but it should be watched once real traffic arrives.

### 2. Four sorts and three searches were full scans

`content.story` had no index on any column the list sorts use, so every page
of trending, newest, views and rating read and sorted the whole table. Title
and author search use `ILIKE '%term%'`, which no btree can serve, so author
search scanned every account. It was **50ms per call** at 20k users and took
21% of all database time from 3.5% of requests.

Fixed in migration `20261120T0747_add_story_sort_and_search_indexes`:

- **Sort indexes:** one btree per sort.
- **Search indexes:** `pg_trgm` GIN indexes on `story.title`,
  `user.username` and `user.displayName`.

| Query | Before | After |
| --- | --- | --- |
| Trending page | 4.6 ms (seq scan + sort) | 0.1 ms (index scan) |
| Author search | 27–50 ms (seq scan) | ~5 ms (bitmap index scan) |
| All DB time, same 2,600 requests | 22.4 s | 10.7 s |

### 3. The same public pages were rebuilt for every reader

`lib/read-cache.ts` is a 30-second in-process cache. It covers story lists, a
story's page, its related rail, its chapter list, and the catalogue
(`/books`). Signed-in readers share the anonymous copy unless they have
written a story themselves. Authors are served fresh, because they also see
their drafts (`seesPublicView` in `services/stories.ts`).

Writes through `/api/author`, `/api/account` and `/api/moderation`, an
automated hide, and a scheduled chapter release all clear it after commit.
Views and chapter reads are still recorded for every request.

Not cached: chapter bodies, which carry a live like count and `likedByMe`;
anything personal; and the AI routes.

Same build, 50 concurrent readers, 20 seconds:

| | Cache off | Cache on |
| --- | --- | --- |
| Anonymous throughput | 204 req/s | **555 req/s** |
| Anonymous p50 | 247 ms | **12 ms** |
| Signed-in throughput | 125 req/s | **180 req/s** |

Signed-in readers gain less. Every request still verifies a token, checks
Redis for revocation and probes for authorship, and recommendations dominate
that mix (next).

With more than one API instance, each holds its own copy and a write clears
only the instance that served it. The others catch up within the 30 seconds.
`READ_CACHE_SECONDS` sets the TTL; `0` turns the cache off, as the test suite
does.

### 4. Open: recommendations scale with the catalogue

`GET /recommendations` costs **~160 ms of Postgres time per request** at 5,000
listed stories, and the cost is linear in that number. The ranking scores
every candidate story. Most of the time goes to three correlated subqueries
run once per candidate: preferred-genre hits, taste weight, and "follows the
author". Rewriting them as grouped joins is the next change.

## Re-running

The seed is not idempotent: run it once per fresh `scribe_load`. To start
over, `drop database scribe_load` and repeat the recipe.
