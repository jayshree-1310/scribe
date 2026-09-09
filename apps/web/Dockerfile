# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------------------
# deps
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter web...

# ---------------------------------------------------------------------------
# dev: Vite dev server with HMR; sources bind-mounted by Compose.
# ---------------------------------------------------------------------------
FROM deps AS dev
ENV NODE_ENV=development
COPY . .
EXPOSE 1302
# `--host` binds 0.0.0.0; Vite listens on localhost only by default, which is
# unreachable from outside the container.
CMD ["pnpm", "--filter", "web", "dev", "--host", "0.0.0.0"]

# ---------------------------------------------------------------------------
# build: Vite inlines VITE_* values at build time, so they arrive as build
# args rather than runtime env vars.
# ---------------------------------------------------------------------------
FROM deps AS build
ARG VITE_GOOGLE_CLIENT_ID=""
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID
COPY . .
RUN pnpm --filter web build

# ---------------------------------------------------------------------------
# runtime: static assets behind nginx, which also proxies /api to the API.
# ---------------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime
ENV API_UPSTREAM=http://api:3000
COPY apps/web/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
