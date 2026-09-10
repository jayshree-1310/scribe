# syntax=docker/dockerfile:1.7

# Debian rather than Alpine on purpose: `argon2` ships prebuilt binaries for
# glibc only (see its `prebuilds/linux-x64`), so on musl every image build
# would fall back to compiling it from source with node-gyp.
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------------------
# deps: manifests only, so `pnpm install` is re-run only when a dependency
# changes and not on every source edit.
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Both app manifests: `--frozen-lockfile` compares the lockfile against every
# workspace package, so omitting `web` would fail the check.
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter api...

# ---------------------------------------------------------------------------
# dev: full dev dependencies, sources bind-mounted by Compose, tsx watch.
# ---------------------------------------------------------------------------
FROM deps AS dev
ENV NODE_ENV=development
COPY . .
EXPOSE 3000
CMD ["pnpm", "--filter", "api", "dev"]

# ---------------------------------------------------------------------------
# build: compile TypeScript to dist/.
# ---------------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN pnpm --filter api build

# ---------------------------------------------------------------------------
# prod-deps: the same install, minus dev dependencies.
# ---------------------------------------------------------------------------
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter api... --prod

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY apps/api/package.json ./apps/api/package.json
# Migrations and the Prisma config travel with the image so `prisma db
# migrate` can be run against a deployed release.
COPY apps/api/prisma.config.ts ./apps/api/prisma.config.ts
COPY apps/api/migrations ./apps/api/migrations
# Uploads are written at runtime by the unprivileged user, and a volume
# mounted here inherits this ownership — without it the first avatar upload
# fails on a root-owned directory.
RUN mkdir -p /var/lib/scribe/uploads && chown -R node:node /var/lib/scribe
USER node
WORKDIR /app/apps/api
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
