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
RUN apk add --no-cache openssl wget
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

ENV NODE_ENV=production
COPY --from=build /repo/pnpm-workspace.yaml /repo/package.json /repo/pnpm-lock.yaml ./
COPY --from=build /repo/apps/api/package.json ./apps/api/
COPY --from=build /repo/packages/shared/package.json ./packages/shared/

RUN pnpm install --prod --frozen-lockfile

COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/prisma ./apps/api/prisma
COPY --from=build /repo/packages/shared/dist ./packages/shared/dist

RUN pnpm --filter @pipelineflow/api exec prisma generate

# Drop privileges. The base image's `node` user has uid 1000 — fine for
# bind-mounted volumes from typical Linux hosts.
RUN chown -R node:node /app
USER node

WORKDIR /app/apps/api
EXPOSE 4000

# Run migrations on boot, then start. Idempotent.
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node dist/index.js"]
