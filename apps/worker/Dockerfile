# PipelineFlow background worker.
#
# DO NOT add `prisma migrate deploy` to this image. The api owns migrations
# (and the pre-migrate backup); the worker just needs the generated client.
# Running migrations from two containers would race and double-dump.

# ── build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
RUN apk add --no-cache python3 make g++ openssl
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/worker/package.json apps/worker/
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
# The Prisma schema lives under apps/api as the single source of truth; the
# worker's prisma:generate script reads it from there at build time. We only
# need the schema file — NOT the migrations directory. Copying migrations
# would bloat the image and tempt a future maintainer into running
# `prisma migrate deploy` from the worker, which would race the api.
COPY apps/api/prisma/schema.prisma apps/api/prisma/schema.prisma
COPY apps/worker apps/worker

RUN pnpm --filter @pipelineflow/shared run build
RUN pnpm --filter @pipelineflow/worker run prisma:generate
RUN pnpm --filter @pipelineflow/worker run build

# ── runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
RUN apk add --no-cache openssl wget
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

ENV NODE_ENV=production
COPY --from=build /repo/pnpm-workspace.yaml /repo/package.json /repo/pnpm-lock.yaml ./
COPY --from=build /repo/apps/worker/package.json ./apps/worker/
COPY --from=build /repo/apps/api/package.json ./apps/api/
COPY --from=build /repo/packages/shared/package.json ./packages/shared/

RUN pnpm install --prod --frozen-lockfile

COPY --from=build /repo/apps/worker/dist ./apps/worker/dist
# Schema only — migrations stay in the api image (see build-stage comment).
COPY --from=build /repo/apps/api/prisma/schema.prisma ./apps/api/prisma/schema.prisma
COPY --from=build /repo/packages/shared/dist ./packages/shared/dist

RUN pnpm --filter @pipelineflow/worker run prisma:generate

RUN chown -R node:node /app
USER node

WORKDIR /app/apps/worker
EXPOSE 4001

CMD ["node", "dist/index.js"]
