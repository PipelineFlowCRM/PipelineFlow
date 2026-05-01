# ── build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
RUN apk add --no-cache python3 make g++ openssl
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api

RUN pnpm --filter @pipelineflow/shared run build
RUN pnpm --filter @pipelineflow/api exec prisma generate
RUN pnpm --filter @pipelineflow/api run build

# ── runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
# postgresql16-client provides pg_dump for the pre-migrate backup taken by
# scripts/start.sh. Keep this aligned with the postgres service version in
# docker-compose.yml — pg_dump <16 can't dump from a 16 server.
RUN apk add --no-cache openssl wget postgresql16-client
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

ENV NODE_ENV=production
COPY --from=build /repo/pnpm-workspace.yaml /repo/package.json /repo/pnpm-lock.yaml ./
COPY --from=build /repo/apps/api/package.json ./apps/api/
COPY --from=build /repo/packages/shared/package.json ./packages/shared/

RUN pnpm install --prod --frozen-lockfile

COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/prisma ./apps/api/prisma
COPY --from=build /repo/apps/api/scripts ./apps/api/scripts
COPY --from=build /repo/packages/shared/dist ./packages/shared/dist

RUN pnpm --filter @pipelineflow/api exec prisma generate

# Backup volume mount point. Created here so it has the right ownership
# even if the host doesn't bind-mount over it.
RUN mkdir -p /backups && chown -R node:node /backups

# Drop privileges. The base image's `node` user has uid 1000 — fine for
# bind-mounted volumes from typical Linux hosts.
RUN chown -R node:node /app
RUN chmod +x /app/apps/api/scripts/start.sh
USER node

WORKDIR /app/apps/api
EXPOSE 4000

# scripts/start.sh: pre-migrate pg_dump → migrate deploy → node dist/index.js.
# See that file for the backup behavior + env var knobs.
CMD ["/app/apps/api/scripts/start.sh"]
