<p align="center">
  <img src="./assets/feature-graphic.png" alt="PipelineFlow — a clean, self-contained sales pipeline CRM" width="100%" />
</p>

# PipelineFlow

A clean, self-contained sales pipeline CRM. Kanban-first, dark-mode native, keyboard-driven. Designed for small teams that want to track deals, follow-ups, and pipeline value without the bloat of a full SFA suite.

> **Status:** early. Single-tenant by design — every signed-in user shares one workspace and can see/edit all deals, contacts, and companies. Multi-tenant / RBAC isn't on the near-term roadmap.

## Features

- **Kanban pipeline** with drag-and-drop stage moves, configurable stages (won / lost / open).
- **Deals** with amount, probability, weighted value, expected close date, tags, owner, primary contact, activity log.
- **Companies + contacts** with simple CRM linking; case-insensitive uniqueness on company name.
- **Tasks** assigned to deals or freestanding, with a due-date calendar view.
- **Notes + file attachments** per deal (S3 presigned uploads).
- **Reports** — pipeline by stage, win/loss, conversion funnel, CSV export.
- **Dashboard** — KPIs (open value, weighted, win rate), overdue tasks, recent activity.
- **Auth** — email/password with argon2id hashing, DB-backed sessions (httpOnly + SameSite=Lax cookies), per-device session revocation, rate-limited credential endpoints.
- **CSRF** via Origin/Referer check on every mutating request.
- **Keyboard** — `⌘K` / `/` for command palette, `c` for quick-lead.
- **Dark mode** is the default; system/light/dark user preference.

## Stack

- **Backend** — Node 20 + Express + TypeScript, Prisma (PostgreSQL), argon2 password hashing, DB-backed sessions, Zod validation, S3 attachments via presigned URLs, helmet + tight CSP, in-process rate limiting.
- **Frontend** — Vite + React 18 + TypeScript, React Router, TanStack Query, Tailwind + Radix primitives (shadcn-style), `@dnd-kit` Kanban, Recharts, FullCalendar, cmdk command palette.
- **Database** — PostgreSQL 16.
- **Deploy** — `docker compose up -d --build` (one stack: postgres + api + web).

## Repo layout

```
pipeline-flow/
├── apps/
│   ├── api/          # Express API + Prisma
│   └── web/          # Vite React SPA
├── packages/
│   └── shared/       # Zod schemas + DTOs shared between api + web
├── docker-compose.yml
├── pnpm-workspace.yaml
└── package.json
```

## Local development

Requires Node 20+, pnpm 9+, and Docker (for Postgres).

```bash
# 1. Install dependencies
pnpm install

# 2. Start Postgres (binds to host port 5439 to avoid colliding with a native Postgres)
docker compose up -d postgres

# 3. Configure env (root + api)
cp .env.example .env
cp apps/api/.env.example apps/api/.env

# 4. Migrate + seed
pnpm --filter @pipelineflow/api run prisma:migrate:dev
pnpm --filter @pipelineflow/api run prisma:seed

# 5. Run dev servers
pnpm dev
```

- Web: <http://localhost:5173>
- API: <http://localhost:4000>
- Login: `demo@pipelineflow.app` / `demo1234` (created by the seed script — not present in production builds)

The Vite dev server proxies `/api` → `http://localhost:4000`, so no CORS in dev.

## Production deploy

```bash
cp .env.example .env
# Edit .env and set REAL values for at least:
#   POSTGRES_PASSWORD        (do NOT ship the dev default)
#   APP_ORIGIN               (your public URL, e.g. https://crm.example.com)
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / S3_BUCKET / S3_REGION
docker compose up -d --build
docker compose exec api pnpm db:seed   # optional demo data
```

By default the published ports (`api`, `web`, `postgres`) bind to `127.0.0.1` only. **You are expected to put a TLS-terminating reverse proxy (Caddy / Traefik / nginx) in front of the `web` service.** If you really do want to expose the containers directly on the LAN, set `BIND_HOST=0.0.0.0` in `.env` — but only after you've thought about TLS.

The `web` container is nginx serving the React build and reverse-proxying `/api/*` to `api:4000`. Postgres data lives in the named volume `pipelineflow-pgdata`.

**Migrations run automatically** on every `api` container start (`prisma migrate deploy` is in the Dockerfile's CMD, before the server boots). New migrations are applied on the next `docker compose up -d --build`.

### Reverse proxy

Set `APP_ORIGIN` in `.env` to your public URL — the API uses it for the CORS allow-list, the cookie domain, and the Origin/Referer CSRF check.

### Backups

```bash
docker compose exec postgres pg_dump -U pipelineflow pipelineflow > backup.sql
```

## File uploads

Attachments and avatars use **AWS S3 (or any S3-compatible store)** via short-lived presigned URLs. Configure:

- `S3_BUCKET`, `S3_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- `S3_ENDPOINT` (optional — set this for MinIO / Cloudflare R2 / Backblaze B2)

The browser uploads directly to S3; the API only signs the URL and persists the resulting object key. Keys are then resolved to short-lived presigned GET URLs at read time, so the bucket can stay private. Attachments-create only accepts keys the API just issued via `/uploads/presign` — clients can't register arbitrary S3 keys.

## Auth

Session cookies (httpOnly, SameSite=Lax) backed by a `Session` table in Postgres. Sessions live 30 days, with `lastSeenAt` updated lazily. Profile → Sessions lets users revoke any device. Changing password or email revokes every other session automatically.

CSRF is handled with an Origin/Referer header check on every mutating request — sufficient for cookie-auth APIs that don't accept third-party form posts.

Login + password-change endpoints are rate-limited per IP (default: 10 attempts / 5 min — configurable via `RATE_LIMIT_LOGIN_MAX` / `RATE_LIMIT_WINDOW_MS`).

## Available scripts

| Command | Description |
| --- | --- |
| `pnpm dev` | Run api + web concurrently |
| `pnpm build` | Build both packages |
| `pnpm db:migrate` | Apply Prisma migrations |
| `pnpm db:seed` | Reset + seed demo data |
| `pnpm db:studio` | Open Prisma Studio |
| `pnpm lint` | Type-check both packages |
| `pnpm test` | Run vitest unit tests |

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for build conventions, test expectations, and PR guidelines.

## License

[Mozilla Public License 2.0](./LICENSE) — file-level copyleft. You can use this in proprietary products as long as modifications to MPL-licensed files are themselves released under the MPL.
