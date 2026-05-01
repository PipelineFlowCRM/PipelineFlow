<p align="center">
  <img src="./assets/feature-graphic.png" alt="PipelineFlow — a clean, self-contained sales pipeline CRM" width="100%" />
</p>

# PipelineFlow

A clean, self-contained sales pipeline CRM. Kanban-first, dark-mode native, keyboard-driven. Designed for small teams that want to track deals, follow-ups, and pipeline value without the bloat of a full SFA suite.

> **Status:** early. Single-tenant by design — every signed-in user shares one workspace and can see/edit all deals, contacts, and companies. Multi-tenant / RBAC isn't on the near-term roadmap.

## Features

- **Kanban pipeline** with drag-and-drop stage moves, configurable stages (won / lost / open).
- **Deals** with amount, probability, weighted value, expected close date, owner, primary contact, activity log.
- **Companies + contacts** with simple CRM linking; case-insensitive uniqueness on company name.
- **MCP server** — first-party Model Context Protocol endpoint at `/api/mcp` so Claude (and any other MCP-capable agent) can read and update the pipeline through 29 structured tools. Bearer-token auth with per-token `read` / `write` / `delete` scopes; every destructive call requires a per-call approval token; full audit log per call.
- **Polymorphic tags** — one tag attaches to deals, companies, and/or contacts. Search-and-create picker, inline rename + recolor, deterministic auto-color palette for new tags, multi-tag AND/OR filter on every list view, usage-aware delete confirms.
- **Custom fields** per entity type (deal / company / contact) — text, long text, number, money, date, email, URL, phone, boolean, single-select, and multi-select. EAV-stored so adding a field doesn't migrate the schema; surfaceable as toggleable columns and filterable on list views.
- **Tasks** assigned to deals or freestanding, with a due-date calendar view.
- **Notes + file attachments** per deal (S3 presigned uploads).
- **Reports** — pipeline by stage, win/loss, conversion funnel, CSV export.
- **Dashboard** — KPIs (open value, weighted, win rate), overdue tasks, recent activity.
- **Auth** — email/password with argon2id hashing, DB-backed sessions (httpOnly + SameSite=Lax cookies), per-device session revocation, rate-limited credential endpoints.
- **CSRF** via Origin/Referer check on every mutating request.
- **Keyboard** — `⌘K` / `/` for command palette, `c` for quick-lead.
- **Dark mode** is the default; system/light/dark user preference.

## Roadmap

Things we're considering next. Not commitments — order will shift as we learn what's actually painful in real use. Contributions welcome on any of these (open an issue first so we can agree on shape).

**Platform**
- **Off-host scheduled backups to S3** — extend the existing on-deploy `pg_dump` (which writes to a local Docker volume) with a scheduled push to the S3 (or S3-compatible) bucket already used for attachments, so dumps survive a host loss without a manual rsync step.
- **Webhooks** — outbound, HMAC-signed payloads on deal / contact / task events, with retry + backoff and a delivery log.
- **Public REST API + scoped API tokens** — the same surface the web app uses, but with token auth and per-token scopes; pairs naturally with webhooks and MCP.

**Integrations**
- **Google Calendar** — two-way sync of tasks and meetings against the per-deal calendar view.
- **Help Scout** — link conversations to contacts and deals so support history shows up in the activity log.
- **Stripe** — link Stripe customers and payments to companies/deals; surface MRR / one-time payment context next to pipeline value.
- **Email integration (Gmail API / IMAP+SMTP)** — log inbound/outbound mail against contacts and deals, send from the deal view, optional template snippets.
- **SSO (Google / Microsoft OAuth)** — alternative login alongside email/password, useful for teams that already centralize identity.

**Sales workflow**
- **Saved views & smart filters** — persist common queries ("my open deals > $50k closing this quarter") with shareable URLs.
- **Deal rotting / stale-deal alerts** — flag deals with no activity for N days in stage X, surface them on the dashboard.
- **CSV import** — bulk import for deals, contacts, and companies, with column mapping; the obvious migration path off another CRM.
- **Quote / proposal PDF generation** — generate a branded PDF from a deal + line items, stored as an attachment.

**Security & ops**
- **Two-factor authentication (TOTP)** — opt-in second factor on top of the existing argon2id + session-cookie flow.
- **Audit log / change history** — append-only log of who changed what (deal stage, amount, owner, etc.) with a per-record timeline view.

## Stack

- **Backend** — Node 20 + Express + TypeScript, Prisma (PostgreSQL), argon2 password hashing, DB-backed sessions, Zod validation, S3 attachments via presigned URLs, helmet + tight CSP, in-process rate limiting.
- **Background worker** — BullMQ on Redis, one container per process. Producer in api, consumer in `apps/worker`. bull-board dashboard mounted at `/admin/queues` (auth-required).
- **Frontend** — Vite + React 18 + TypeScript, React Router, TanStack Query, Tailwind + Radix primitives (shadcn-style), `@dnd-kit` Kanban, Recharts, FullCalendar, cmdk command palette.
- **Database** — PostgreSQL 16.
- **Deploy** — `docker compose up -d --build` (one stack: postgres + redis + api + worker + web).

## Repo layout

```
pipeline-flow/
├── apps/
│   ├── api/          # Express API + Prisma
│   ├── worker/       # BullMQ worker process
│   └── web/          # Vite React SPA
├── packages/
│   └── shared/       # Zod schemas + DTOs shared between api + web + worker
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
docker compose exec api pnpm prisma:seed   # optional demo data
```

### Docker Compose Commands
```bash
docker-compose up # creates and runs a collection of containers
docker-compose stop #stops the containers
docker-compose start #starts the containers
docker-compose down #stops and removes the containers
docker ps #lists the running containers
```

By default the published ports (`api`, `web`, `postgres`) bind to `127.0.0.1` only. **You are expected to put a TLS-terminating reverse proxy (Caddy / Traefik / nginx) in front of the `web` service.** If you really do want to expose the containers directly on the LAN, set `BIND_HOST=0.0.0.0` in `.env` — but only after you've thought about TLS.

The `web` container is nginx serving the React build and reverse-proxying `/api/*` to `api:4000`. Postgres data lives in the named volume `pipelineflow-pgdata`.

**Migrations run automatically** on every `api` container start (`prisma migrate deploy` is in the Dockerfile's CMD, before the server boots). New migrations are applied on the next `docker compose up -d --build`.

### Portainer (stack from Git)

The compose file builds the `api` and `web` images from source (no pre-built images on a registry), so the natural Portainer path is **Stacks → Add stack → Repository**:

1. **Name** — e.g. `pipelineflow`.
2. **Build method** — *Repository*.
3. **Repository URL** — the Git URL of this project. Add credentials if it's private.
4. **Reference** — the branch you want to track, e.g. `refs/heads/master`.
5. **Compose path** — `pipeline-flow/docker-compose.yml` (the compose file lives one level deep in this repo).
6. **Environment variables** — click *Advanced mode* and paste your filled-in `.env`. At minimum set:
   - `POSTGRES_PASSWORD` (required — the compose file refuses to start without it)
   - `APP_ORIGIN` (your public URL, e.g. `https://crm.example.com`)
   - `S3_BUCKET`, `S3_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (and `S3_ENDPOINT` if using MinIO / R2 / B2)
   - Optional: `BIND_HOST`, `WEB_PORT`, `API_PORT`, `POSTGRES_PORT`
7. **GitOps updates** *(optional but recommended)* — enable *Automatic updates* with either a polling interval or a webhook; a `git push` then triggers a rebuild + redeploy. Migrations run automatically on `api` start, so schema changes ride along.
8. **Deploy the stack.**

After it's up, run the seed once (only if you want demo data) from Portainer's container console for `pipelineflow-api`:

```bash
pnpm prisma:seed
```

(The `pnpm db:*` scripts are root-workspace shortcuts; inside the api container only the api package is loaded, so use the `prisma:*` script names directly.)

Notes:

- The Docker host running this stack must have build access — Portainer will run `docker build` for both `api` and `web`. The default Portainer agent setup handles this.
- Built images accumulate over time. `docker system prune -f` on the host periodically is fine; the named volume `pipelineflow-pgdata` is preserved.
- **Removing the stack with "Remove volumes" enabled deletes the database.** Take a `pg_dump` first (see [Backups](#backups)).
- Ports still bind to `127.0.0.1` by default — terminate TLS with a reverse proxy in front (next section). If Portainer and your reverse proxy are on different hosts, either set `BIND_HOST=0.0.0.0` or attach the proxy to the same Docker network as the `web` service.

### Reverse proxy

Set `APP_ORIGIN` in `.env` to your public URL — the API uses it for the CORS allow-list, the cookie domain, and the Origin/Referer CSRF check.

### Backups

Every time the `api` container starts with **pending Prisma migrations**, it takes a gzipped `pg_dump` to the `pipelineflow-backups` Docker volume *before* applying them — so any deploy that ships schema changes always leaves you a pre-migrate snapshot to roll back to. Plain restarts (no schema change) skip the dump, so the volume doesn't accumulate empties.

The dump runs as part of `apps/api/scripts/start.sh`. If the dump fails, the container exits non-zero and the migration does **not** run — your data is left untouched and you can investigate.

Files are named `pipelineflow-<UTC-ISO>-pre-migrate.sql.gz` and are auto-pruned after `BACKUP_RETAIN_DAYS` days (default 30, override in `.env`).

#### Listing backups

```bash
docker compose exec api ls -lh /backups
```

#### Pulling backups off the host

```bash
# copy every file in the volume to ./backups-copy
docker compose cp api:/backups ./backups-copy
```

If the API container is stopped, you can read the volume directly:

```bash
docker run --rm -v pipelineflow-backups:/b alpine ls -lh /b
```

#### Off-host storage

The `pipelineflow-backups` volume lives on the same Docker host as everything else, so it doesn't survive a host loss. To make backups survivable, either:

- **Bind-mount the volume to a host path you already back up.** See the commented driver block on `pipelineflow-backups` in `docker-compose.yml` — uncomment and point `device:` at a path on the host (e.g. `/srv/pipelineflow/backups`).
- **Rsync the directory off-host on a cron.**

#### On-demand backup

You don't have to wait for a deploy:

```bash
docker compose exec postgres pg_dump -U pipelineflow pipelineflow > backup.sql
```

#### Restoring

```bash
gunzip -c pipelineflow-2026....sql.gz \
  | docker compose exec -T postgres psql -U pipelineflow pipelineflow
```

For a fresh DB, drop and recreate first (`DROP DATABASE pipelineflow; CREATE DATABASE pipelineflow;`) so the dump's `CREATE TABLE` statements don't collide with existing rows.

## File uploads

Attachments and avatars use **AWS S3 (or any S3-compatible store)** via short-lived presigned URLs. Configure:

- `S3_BUCKET`, `S3_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- `S3_ENDPOINT` (optional — set this for MinIO / Cloudflare R2 / Backblaze B2)

The browser uploads directly to S3; the API only signs the URL and persists the resulting object key. Keys are then resolved to short-lived presigned GET URLs at read time, so the bucket can stay private. Attachments-create only accepts keys the API just issued via `/uploads/presign` — clients can't register arbitrary S3 keys.

## Auth

Session cookies (httpOnly, SameSite=Lax) backed by a `Session` table in Postgres. Sessions live 30 days, with `lastSeenAt` updated lazily. Profile → Sessions lets users revoke any device. Changing password or email revokes every other session automatically.

CSRF is handled with an Origin/Referer header check on every mutating request — sufficient for cookie-auth APIs that don't accept third-party form posts.

Login + password-change endpoints are rate-limited per IP (default: 10 attempts / 5 min — configurable via `RATE_LIMIT_LOGIN_MAX` / `RATE_LIMIT_WINDOW_MS`).

## MCP server

PipelineFlow ships a first-party [Model Context Protocol](https://modelcontextprotocol.io) endpoint so AI agents (Claude Desktop, Claude Code, custom agents) can read and update the pipeline through structured tools rather than scraping the UI.

The endpoint runs at **`POST /api/mcp`** (Streamable HTTP transport, stateless mode). It is bearer-token authenticated — separate from the cookie-auth used by the web app — and exposes ~29 tools spread across read, write, and delete tiers.

### Issue an API token

1. Sign in to the web app and go to **Settings → API tokens**.
2. Click **New token**, give it a name (e.g. *"Claude Desktop"*), pick the scopes you want, and optionally an expiration.
3. The plaintext token is shown **once** in the format `pf_tok_<id>.<secret>`. Copy it — only the hash is stored on the server.

Tokens are personal — they belong to the issuing user and every MCP action is attributed to that user in the activity log. Revoke from the same page; the change takes effect on the next request.

### Scopes

| Scope    | Grants                                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `read`   | List + get tools across deals, contacts, companies, tasks, notes, tags, stages. Cross-entity search.                    |
| `write`  | Create + update across deals, contacts, companies, tasks, notes, tags. Move deals between stages.                       |
| `delete` | Delete deals, companies, contacts, tasks, notes, tags. Each delete *additionally* requires a per-call approval token (see below). |

A token without a given scope **doesn't even see the corresponding tools** in `tools/list` — well-behaved agents physically cannot invoke them.

### Approval flow for destructive tools

`pipeline.delete_*` tools use a two-phase confirmation:

1. The agent calls the tool **without** `confirmationToken`. The server returns `status: "approval_required"` with an `approvalToken` and a human-readable summary of what would happen.
2. The agent presents the summary to the user, gets explicit confirmation, then calls the tool **again** with the same arguments plus `confirmationToken: <approvalToken>`.

Approval tokens are bound to the (tool, args, API token) triple — you can't approve "delete deal #1" and reuse the token to delete a different deal. They're single-use and expire after 5 minutes.

### Wiring up Claude Desktop / Code

Add an entry to your MCP client config pointing at your PipelineFlow instance, with the bearer token in the `Authorization` header:

```json
{
  "mcpServers": {
    "pipelineflow": {
      "url": "https://crm.example.com/api/mcp",
      "headers": {
        "Authorization": "Bearer pf_tok_xxxx.yyyyyyyyy"
      }
    }
  }
}
```

For local dev (`pnpm dev`):

```json
{
  "url": "http://localhost:4000/api/mcp",
  "headers": { "Authorization": "Bearer pf_tok_xxxx.yyyyyyyyy" }
}
```

### Audit + guardrails

Every MCP call writes a row to `McpAuditEvent` — including `approval_required` and `approval_consumed` outcomes — so an operator can answer "what did the agent do" weeks after the fact. Args are truncated to ~4KB to keep the table bounded.

In addition:

- **Per-IP rate limiting** on `/api/mcp` (300 req / 5 min default).
- **No origin requirement** for bearer auth (agents aren't browsers; the bearer token itself is the credential), but the cookie-auth surface still enforces CSRF as before.
- **No token escalation**: even with a valid bearer token, you cannot call `/api/api-tokens` (those routes require an interactive session).
- **Hashed at rest**: token secrets are stored as Argon2id hashes — same module the password-hash uses.

### Tool list

Read tools: `list_deals`, `get_deal`, `list_companies`, `get_company`, `list_contacts`, `get_contact`, `list_tasks`, `list_stages`, `list_tags`, `search`.
Write tools: `create_deal`, `update_deal`, `move_deal`, `create_company`, `update_company`, `create_contact`, `update_contact`, `create_task`, `update_task`, `create_note`, `update_note`, `create_tag`, `update_tag`.
Delete tools (approval-gated): `delete_deal`, `delete_company`, `delete_contact`, `delete_task`, `delete_note`, `delete_tag`.

All tools are namespaced under `pipeline.*`.

## Background workers

Long-running work (webhooks, scheduled jobs, email sends, off-host backups) runs in `apps/worker` so it can't block the api event loop. The producer lives in the api (`apps/api/src/lib/queue.ts`); the consumer is the dedicated `worker` container.

- **Broker** — Redis 7 (`redis` service in `docker-compose.yml`). `--maxmemory-policy noeviction` is mandatory: any other policy can silently lose queued jobs.
- **Concurrency** — set `WORKER_CONCURRENCY` (default 5) in `.env`. The worker's Prisma `DATABASE_URL` is configured with `?connection_limit=10` to keep the pool from starving under fanout.
- **Visibility** — bull-board UI is mounted at `/admin/queues` on the api (auth-required, gated by `BULL_BOARD_ENABLED`). BullMQ is also compatible with [Taskforce.sh](https://taskforce.sh/) if you want a hosted dashboard later.
- **Smoke test** — there's a no-op `generate` queue you can drive end-to-end:

  ```bash
  # Log in first to get the session cookie, then from the browser console:
  await fetch('/api/jobs/generate', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sleepMs: 3000, label: 'smoke-test' }),
  }).then(r => r.json())
  # → { jobId: '<id>' }
  await fetch('/api/jobs/generate/<id>', { credentials: 'include' }).then(r => r.json())
  # → { state: 'completed', returnvalue: { generated, completedAt, label } }
  ```

  The same job will appear in `/admin/queues` with progress and return value.

## Available scripts

Run from the workspace root (host). Inside the `api` container only the api package is loaded, so use the `prisma:*` script names directly there (e.g. `docker compose exec api pnpm prisma:seed`).

| Command | Description |
| --- | --- |
| `pnpm dev` | Run api + worker + web concurrently |
| `pnpm build` | Build all packages |
| `pnpm db:migrate` | Apply Prisma migrations (host shortcut for `pnpm --filter @pipelineflow/api run prisma:migrate`) |
| `pnpm db:seed` | Reset + seed demo data (host shortcut for `prisma:seed`) |
| `pnpm db:studio` | Open Prisma Studio (host shortcut for `prisma:studio`) |
| `pnpm lint` | Type-check all packages |
| `pnpm test` | Run vitest unit tests |

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for build conventions, test expectations, and PR guidelines.

## License

[Mozilla Public License 2.0](./LICENSE) — file-level copyleft. You can use this in proprietary products as long as modifications to MPL-licensed files are themselves released under the MPL.
