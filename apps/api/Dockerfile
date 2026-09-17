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
# Migrations, the contract and the Prisma config travel with the image so the
# release can migrate its own database at boot -- see
# apps/api/scripts/migrate-on-boot.mjs. The contract is what names the target,
# so shipping it beside the migrations is what makes the target always equal
# what this release's code expects.
COPY apps/api/prisma.config.ts ./apps/api/prisma.config.ts
COPY apps/api/migrations ./apps/api/migrations
COPY apps/api/src/prisma/contract.prisma ./apps/api/src/prisma/contract.prisma
COPY apps/api/src/prisma/contract.json ./apps/api/src/prisma/contract.json
COPY apps/api/scripts/migrate-on-boot.mjs ./apps/api/scripts/migrate-on-boot.mjs
COPY apps/api/docker-entrypoint.sh ./apps/api/docker-entrypoint.sh
# `COPY` preserves the host's modes, and this repo's files are group-readable
# only (`-rw-rw----`), so every one of them arrives unreadable by the
# unprivileged `node` user that runs the container. `dist/` escapes it by being
# built inside the image; everything copied from the host does not. Normalise
# the modes rather than the umask on fifteen developer machines.
#
# `a+rX` is a capital X on purpose: read for everyone, execute only where it
# already applies -- directories, which need it to be traversed at all.
RUN chmod -R a+rX \
      ./apps/api/migrations \
      ./apps/api/src \
      ./apps/api/scripts \
      ./apps/api/prisma.config.ts \
      ./apps/api/package.json \
 && chmod 0755 ./apps/api/docker-entrypoint.sh
# Uploads are written at runtime by the unprivileged user, and a volume
# mounted here inherits this ownership — without it the first avatar upload
# fails on a root-owned directory.
RUN mkdir -p /var/lib/scribe/uploads && chown -R node:node /var/lib/scribe
USER node
WORKDIR /app/apps/api
EXPOSE 3000
# start-period covers migrations now, not just boot: the container is not
# unhealthy while it is applying DDL it was told to apply.
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["./docker-entrypoint.sh"]
