# Scribe — Deploying to Render

Render has no Docker daemon inside a running service, so `docker-compose.yml`
cannot be deployed as-is: one Render service is one container or one process.
The four Compose services become four separate resources.

| Compose service | Render resource |
| --- | --- |
| `postgres` | External Neon database (Render deletes free Postgres after 30 days) |
| `redis` | Key Value add-on |
| `api` | Web Service, still built from `apps/api/Dockerfile` |
| `web` | Static Site — Render serves and CDN-caches the bundle, so nginx buys nothing |

`render.yaml` in the repo root is the blueprint form of everything below. The
`New` menu inside a Render project has no Blueprint entry, so the steps here
create the services by hand; the file remains the authoritative list of
settings and environment variables.

Every resource is on a free plan. That constrains three things: the database is
external, uploads do not persist (a free instance cannot mount a disk), and the
API sleeps after 15 minutes idle.

## Deployed URLs

- Web — <https://scribe-web-7mpz.onrender.com>
- API — <https://scribe-new.onrender.com> (no route at `/`; only `/health` and `/api/*`)

## Current state

Neon holds the schema, all 344 rows and the signed contract marker.

The database migrates itself on deploy — see [Migrations](#migrations).

An earlier version of this section said there was no pending migration and not
to run `prisma db migrate`. That was true on 2026-09-15 and stopped being true
the next day; it is why the badges 500 below went unnoticed for two days. Do
not restate the database's state here — run `prisma migration status` and let
it answer.

## 1. Key Value store

First, because the API needs its internal URL. **New → Key Value**.

| Field | Value |
| --- | --- |
| Name | `scribe-redis` |
| Region | Oregon |
| Plan | Free |
| Maxmemory policy | `allkeys-lru` |

Copy the **Internal** Key Value URL (`redis://red-…:6379`). The region must
match the API's — the internal URL only resolves within one region.

Free Key Value has no persistence, which is fine: it holds rate limits, refresh
sessions and one-time tokens, so a restart signs everyone out and nothing more.

## 2. API

**New → Web Service** → `jayshree-1310/scribe`.

| Field | Value |
| --- | --- |
| Name | `scribe-new` (Render appends a suffix if the name is taken) |
| Region | Oregon |
| Branch | `main` |
| Root Directory | *blank* |
| Language | Docker |
| Dockerfile Path | `./apps/api/Dockerfile` |
| Docker Build Context | `.` |
| Health Check Path | `/health` |
| Instance Type | Free |

Render auto-detects Node from the root `package.json` and shows **Build
Command** and **Start Command**. Those are the wrong fields — change
**Language** to `Docker` (it sits above Region) and the form replaces them with
Dockerfile Path and Build Context.

Root Directory must stay blank: the Dockerfile copies `pnpm-workspace.yaml` and
both app manifests from the repo root, and narrowing the context fails
`--frozen-lockfile`.

Generate two fresh JWT secrets — not the ones in `apps/api/.env`:

```bash
openssl rand -base64 48   # run twice
```

| Key | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `NODE_OPTIONS` | `--dns-result-order=ipv4first --network-family-autoselection-attempt-timeout=2000` |
| `DATABASE_URL` | Neon **pooled** URL (host contains `-pooler`) |
| `REDIS_URL` | internal URL from step 1 |
| `JWT_ACCESS_SECRET` | first generated secret |
| `JWT_REFRESH_SECRET` | second generated secret |
| `JWT_ACCESS_EXPIRES_IN` | `15m` |
| `JWT_REFRESH_EXPIRES_IN` | `30d` |
| `LOG_LEVEL` | `info` |
| `TRUST_PROXY` | `1` |
| `UPLOAD_DIR` | `/var/lib/scribe/uploads` |
| `GOOGLE_CLIENT_ID` | same id as `apps/api/.env` |
| `PUBLIC_UPLOAD_BASE_URL` | left blank until step 4 |
| `CORS_ORIGIN` | left blank until step 4 |

`PORT` is injected by Render and `server.ts` already reads it.

**Never set `ALLOW_DEV_USER_HEADER` here.** It is `true` locally so the web app
can act as a reader before auth is wired up; in a deployed environment it lets
any caller impersonate any user.

Deploy, then copy the service URL.

## 3. Web

**New → Static Site** → same repo.

| Field | Value |
| --- | --- |
| Name | `scribe-web` |
| Root Directory | *blank* |
| Build Command | `corepack enable && pnpm install --frozen-lockfile && pnpm --filter web build` |
| Publish Directory | `apps/web/dist` |
| `VITE_API_URL` | `https://scribe-new.onrender.com/api` — the trailing `/api` matters |
| `VITE_GOOGLE_CLIENT_ID` | same Google client id |

The publish directory is `apps/web/dist`, with the `s`. A wrong path here
fails *after* a successful build, with `Publish directory ... does not exist!`
below a clean `✓ built in 345ms` — so read the last line, not the build
output.

Then **Redirects/Rewrites** → source `/*`, destination `/index.html`, action
**Rewrite**. This is the React Router fallback that `apps/web/nginx.conf`
handled with `try_files`. A redirect instead of a rewrite rewrites the address
bar and breaks deep links.

## 4. Close the loop

Both URLs exist now, so fill in the two that reference each other. On
`scribe-new` → Environment:

| Key | Value |
| --- | --- |
| `CORS_ORIGIN` | `https://scribe-web-7mpz.onrender.com` |
| `PUBLIC_UPLOAD_BASE_URL` | `https://scribe-new.onrender.com` |

Without `CORS_ORIGIN` every browser call fails: `apps/web/src/lib/api-client.ts`
sends `credentials: 'include'`, and a wildcard origin is rejected for
credentialed requests.

Vite inlines `VITE_*` at build time, so changing `VITE_API_URL` needs a full
**redeploy** of the static site, not a restart.

## 5. Google OAuth

Google Cloud Console → Credentials → the OAuth client → add
`https://scribe-web-7mpz.onrender.com` to **Authorised JavaScript origins**. Sign-in
fails silently without this.

The same client id must be set on both sides: the API verifies that each ID
token was minted for that audience.

## 6. Delete the old service

The suspended Node service still carries `docker compose up --build` as its
start command. It cannot be salvaged into a working setup — it is one native
service trying to be four things. Settings → Delete Service.

## 7. Verify

```bash
curl https://scribe-new.onrender.com/health
```

Then load the site and confirm the 56 stories render, and that sign-in works.

Two things look broken but are not:

- The first request after idle takes about 50 seconds. Free instances sleep
  after 15 minutes, and `server.ts` awaits `connectRedis()` before it listens,
  so the wake-up includes a Redis reconnect.
- Avatars and covers 404. Those files live only in `backups/`; a free instance
  mounts no disk, so `UPLOAD_DIR` is wiped on every deploy and spin-down.

## 8. Rotate the Neon password

Do this last, once Render holds a working `DATABASE_URL` — resetting earlier
just means pasting a stale value.

Neon console → Branches → `production` → Roles → `neondb_owner` → Reset
password. Update `DATABASE_URL` on `scribe-new` immediately, then:

```bash
rm backups/neon.url
```

## Migrations

**Migrations apply themselves on deploy.** The container runs
[`apps/api/scripts/migrate-on-boot.mjs`](../apps/api/scripts/migrate-on-boot.mjs)
before the server, and a release that cannot migrate never becomes healthy —
so Render keeps the previous one serving instead of putting up an instance that
500s. Adding a migration is just committing it.

Running it in the container rather than as a Render pre-deploy command is
forced: that hook is paid-tier only.

Three things make this safe to run on every boot, cold starts included:

- **It is idempotent.** `prisma_contract.contract` holds one row per applied
  contract state, so a database already at the target reports *"Already up to
  date — nothing to run"* and issues no DDL. Nothing re-applies.
- **The target is the contract in the image.** Both the migrations and the
  contract ship in it, so the destination is by construction what this
  release's code expects. No `production` ref to remember to advance — that
  would be the same class of mistake that caused the outage.
- **Destructive migrations are refused.** `prisma db migrate` has no
  confirmation prompt of its own, so the script reads each pending migration's
  `ops.json`, and any `destructive` operation stops the boot with the drops
  named. Additive migrations, which is nearly all of them, pass straight
  through.

### Required environment

| Variable | Why |
| --- | --- |
| `MIGRATE_DATABASE_URL` | The same database on its **direct** endpoint. `DATABASE_URL` is Neon's pooled host, and PgBouncer in transaction mode breaks migration DDL — see [Pooled vs direct](#pooled-vs-direct-neon-endpoints). The container refuses to start rather than attempt DDL through the pooler. |
| `MIGRATE_ALLOW_DESTRUCTIVE` | Set to `true` for a single deploy to let a migration that drops something through. Take a backup first, then unset it. |
| `MIGRATE_ON_BOOT` | `false` disables the step, for a release that must start against a database somebody else is migrating. |

### Asking what is about to run

```bash
NODE_OPTIONS="--dns-result-order=ipv4first --network-family-autoselection-attempt-timeout=2000" \
DATABASE_URL="<neon direct url>" pnpm --filter api exec prisma migration status
```

`migration status` reads the live marker as its origin and reports each
migration as `applied` or `pending`. `prisma migration log` shows the applied
history. Neither writes anything.

### Applying by hand

`backups/migrate-neon.sh` does the same thing from a laptop, and additionally
takes a `pg_dump` first. Use it for the initial catch-up on a database that is
behind, or when you want the backup. It reads the connection string from
`backups/neon.url` — one line, the direct host; `backups/` is gitignored — and
passes it through the environment rather than `--db`, so it reaches neither
shell history nor the process list. It pins `--to` the contract the deployed
image carries, since a working tree can be ahead of what is running.

### Badges answered 500 on every request (2026-09-17)

The symptom: `GET /api/users/<name>/badges` and `GET /api/badges` returned
`internal_error` while `/health` and `/api/stories` were fine — so not CORS,
not auth, not the instance.

Commit `14cda7f` re-keyed `gamification.userBadge` from a `badgeId` foreign key
onto a `code` column and dropped the `gamification.badge` catalogue, which now
lives in `services/gamification.ts`. Its migration never reached Neon, so the
deployed code selected a column the table did not have. Two migrations were
pending in all — `20260915T1011` (`engagement.chapterRead`, `engagement.storyView`)
and `20260916T1041` — because the database had sat at `efd4d8e5` since the
first deployment.

Fixed by running the migration above. Both dropped tables were empty, as the
migration's own comment predicts: nothing ever wrote `userBadge` under the old
schema, since the award engine arrived with the new one.

The ORM runtime does not check the contract marker, so a marker mismatch never
announces itself — only `prisma db verify` sees it, and only a query against a
missing column fails. That is the general shape of this bug: the drift is
silent until one route touches it.

## Things that bite

Four failures cost real time during the first deployment. None are obvious from
their error messages.

### `DRIVER.CONNECTION_FAILED` with an empty `why:`

Not Prisma, not Neon, not credentials. The real error is in the underlying pg
error object:

```
AggregateError [ETIMEDOUT] at internalConnectMultiple (node:net:1134:18)
```

`internalConnectMultiple` is Node's Happy Eyeballs. Neon's hostname carries both
A and AAAA records; on a host with no IPv6 route Node burns its 250 ms
per-address budget on the dead family and reports a bogus timeout. The tell is
the timing — it fails in under a second against a 30 second timeout.

Fix, for any Node process that talks to Neon:

```bash
NODE_OPTIONS="--dns-result-order=ipv4first --network-family-autoselection-attempt-timeout=2000"
```

This is why the variable is set on the API service, not only locally.

### An empty hero and no data, but every endpoint returns 200

`CORS_ORIGIN` unset takes the `undefined` branch in `app.ts`, which is
permissive-wildcard mode: `Access-Control-Allow-Origin: *` with no
`Allow-Credentials`. Browsers reject that combination for credentialed
requests, so every call fails silently in the browser while `curl` — which
sends no `Origin` — sees a healthy API. Check for `access-control-allow-origin`
echoing your exact web origin, not `*`.

### Pooled vs direct Neon endpoints

The pooled host (`-pooler` in the name) is PgBouncer in transaction mode. Use
it for the running app. Use the **direct** host for anything that runs DDL —
`pg_restore`, `prisma db init`, `prisma db migrate`.

### `pg_restore: unsupported version (1.16) in file header`

The host has PostgreSQL 16 client tools (Ubuntu 24.04 ships 16) and the dump was
written by `pg_dump` 17. Rather than adding the PGDG repo, run the restore
through the container, which already has 17:

```bash
docker exec -i scribe-postgres pg_restore --no-owner --no-privileges \
  -d "$URL" < backups/scribe-full-<ts>.dump
```

`backups/restore-to-neon.sh` wraps this with guards for the pooled endpoint, a
missing URL file and a stale placeholder.

### A production URL in `apps/api/.env`

`docker-compose.yml` overrides `DATABASE_URL` in its `environment:` block, so
the dev container is always on the Compose Postgres regardless of what the file
says. Host-run commands are not protected: `pnpm --filter api seed:books`,
`pnpm test` and the `prisma` CLI all read `apps/api/.env` directly.

Production credentials therefore live only in Render's environment variables.
For a one-off command against Neon, pass the URL inline for that process:

```bash
NODE_OPTIONS="--dns-result-order=ipv4first --network-family-autoselection-attempt-timeout=2000" \
DATABASE_URL="$(tr -d ' \t\r\n' < ../../backups/neon.url)" \
pnpm exec prisma db migrate --yes
```

## Backups

`backups/` is gitignored and holds a full dump, a data-only dump, a plain SQL
dump and a tar of the upload volume, plus `restore-to-neon.sh` and a `README.md`
covering both restore paths. `pg_dump` does not cover uploaded files — the rows
only store their URLs — so the tar is separate and, on the free tier, the only
copy.

Re-run the dump commands in that README before any future migration so you
carry current data rather than the September snapshot.

## Uploaded files

`createStorage` in `apps/api/src/lib/storage.ts` picks the backend from the
environment. Unset, uploads go to `UPLOAD_DIR` on the local filesystem, which
is what development wants and what the free tier cannot keep: no disk can be
mounted, so that directory is wiped on every deploy and every spin-down. An
instance sleeps after 15 minutes idle, so a cover uploaded through Author
Studio is typically gone within the hour.

Setting `S3_BUCKET` switches every upload — covers, avatars, chapter audio and
video — to an S3-compatible object store instead. Cloudflare R2 is the cheapest
fit: 10 GB free, and no egress charges, which is what matters for images on a
page.

| Variable | Value |
| --- | --- |
| `S3_BUCKET` | Bucket name, e.g. `scribe-media` |
| `S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` (omit for AWS) |
| `S3_PUBLIC_BASE_URL` | The **read** origin: an R2 custom domain, or the bucket's public URL |
| `S3_ACCESS_KEY_ID` | R2 API token id |
| `S3_SECRET_ACCESS_KEY` | R2 API token secret |
| `S3_REGION` | Optional; defaults to `auto`, which is what R2 wants |

`S3_PUBLIC_BASE_URL` is required alongside the bucket and is not the endpoint:
the endpoint is where the API writes, while rows store an address a browser
fetches. Setting one without the other throws at startup, so a misconfigured
deployment fails its health check rather than accepting uploads nothing can
read.

Make the bucket readable through its own configuration — an R2 public bucket or
a custom domain, an S3 bucket policy — rather than per-object ACLs, which R2
does not implement and rejects.

`PUBLIC_UPLOAD_BASE_URL` only applies to the local backend and is ignored once
a bucket is set, since `S3_PUBLIC_BASE_URL` already gives absolute URLs.

### Rows written before the switch

Switching backends does not rewrite existing rows: a story whose `coverUrl` is
`/uploads/covers/….png` still points at a file the instance no longer has.
Re-upload through the app, or patch the row once the file is in the bucket.
Nothing errors in the meantime — `remove` ignores any URL it did not write, so
replacing one of these never fails on cleanup, and the same is true of the
Google profile-picture URLs that share the `avatarUrl` column.

## What is still missing

Nothing blocking. The free tier's remaining constraints are the API's ~50s cold
start after 15 minutes idle, and Neon deleting an unused free database after
30 days.
