# ── build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

ARG VITE_API_URL=/api
# Mapbox public token, inlined into the SPA bundle by Vite. Empty arg is
# accepted — the client falls back to a "Set MAPBOX_API_TOKEN to display the
# map." placeholder rather than crashing.
ARG MAPBOX_API_TOKEN=
ENV MAPBOX_API_TOKEN=${MAPBOX_API_TOKEN}

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web

RUN pnpm --filter @pipelineflow/shared run build
RUN pnpm --filter @pipelineflow/web run build

# ── runtime: nginx serves the SPA + reverse-proxies /api → api service ────────
FROM nginx:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
# Defensive: COPY preserves host permissions, and host umasks vary. Force
# world-readable on static assets so nginx (running as the `nginx` user) can
# always serve them — otherwise a 0600 file in the source tree silently
# 403/permission-denies in the container.
RUN find /usr/share/nginx/html -type f -exec chmod a+r {} + \
 && find /usr/share/nginx/html -type d -exec chmod a+rx {} +
EXPOSE 80
