# Backups

> This file is the canonical source. If you mirror it to the GitHub wiki, sync changes back here.

PipelineFlow keeps the database recoverable through two complementary jobs that share a single Docker volume (`pipelineflow-backups` mounted at `/backups`):

| Job | Trigger | Container | Output |
|---|---|---|---|
| Pre-migrate dump | API container start with pending Prisma migrations | `api` | `pipelineflow-<UTC-ISO>-pre-migrate.sql.gz` on the local volume |
| Scheduled backup | Daily cron (default `42 4 * * *` UTC) + manual trigger | `worker` | `pipelineflow-<UTC-ISO>-<host>-<pid>-scheduled.sql.gz` on the local volume **and** uploaded to S3 under `backups/` |

The scheduled-backup job also performs a **catch-up sweep** on every run: it lists the local volume against the S3 `backups/` prefix and uploads anything missing — including the pre-migrate dumps from the api container. Net effect: you don't have to copy anything by hand to keep backups durable across host loss.

## Configuration

All env vars below have safe defaults; the self-host quickstart needs only the four S3 vars to enable off-host backups.

| Var | Default | Used by | Purpose |
|---|---|---|---|
| `S3_BUCKET` | empty | api, worker | Bucket name. Empty disables S3 push (the dump still runs locally). |
| `S3_REGION` | `us-east-1` | api, worker | Bucket region. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | empty | api, worker | Credentials. |
| `S3_ENDPOINT` | empty | api, worker | Set for any non-AWS S3 (MinIO, R2, B2). Switches the SDK into path-style addressing. |
| `BACKUP_RETAIN_DAYS` | `30` | api, worker | Both stores (local + S3) prune anything older than this. The api also uses it for its pre-migrate prune so the values must match. |
| `BACKUP_DEBOUNCE_SEC` | `300` | api | Suppresses repeated pre-migrate dumps inside a Docker restart loop on a failing migration. |
| `BACKUP_SCHEDULE_CRON` | `42 4 * * *` | api | Cron pattern for the scheduled-backup repeatable. Offset from the s3-reconcile cron (`17 3 * * *`). The api owns producer registration; the worker runs the actual dump. |
| `BACKUP_DIR` | `/backups` | worker | Path where pg_dump output is written. The volume mount makes this match the api's pre-migrate dir. |

## File naming

```
pipelineflow-<UTC-ISO>-pre-migrate.sql.gz                    # api, on-deploy
pipelineflow-<UTC-ISO>-<host>-<pid>-scheduled.sql.gz         # worker, daily/manual
```

The scheduled file embeds hostname + PID to guarantee uniqueness if a pathological double-run ever escapes the Redis lock. The catch-up sweep matches both filename patterns by the shared `pipelineflow-*.sql.gz` glob.

## S3 layout

```
s3://<bucket>/backups/pipelineflow-<UTC-ISO>-pre-migrate.sql.gz
s3://<bucket>/backups/pipelineflow-<UTC-ISO>-<host>-<pid>-scheduled.sql.gz
```

Each object has metadata: `sizeBytes`, `dumpedAt` (and `catchUp=true` for files uploaded by the catch-up sweep). `Content-Type: application/gzip`.

The s3-reconcile job that prunes orphan attachments **does not touch** the `backups/` prefix — backups have no DB row and would otherwise look like orphans. See `apps/worker/src/jobs/s3Reconcile.ts` (`SCOPES`).

## Manual trigger

From the UI: **Settings → Maintenance → Run backup now**.

From the API:
```bash
curl -X POST http://<host>/api/admin/scheduled-backup/run \
  -H "Cookie: <session-cookie>"
```

Response: `{"ok": true, "jobId": "..."}`. If a backup is already in flight the job acquires the Redis lock, finds it held, logs a warning, and returns `{ uploaded: 0, pruned: 0, ... }`. No data is lost.

## Status / monitoring

The worker writes `pf:scheduled-backup:last-success` (epoch ms in Redis) on every clean run. Surfaced as:

- `GET /api/admin/scheduled-backup` → `{ "lastSuccessAt": "<ISO>" | null }`
- The Maintenance card in the web UI.

For external monitoring (uptime-kuma, healthchecks.io, Grafana), pull the GET endpoint and alert if `lastSuccessAt` is older than ~36h. Example uptime-kuma "keyword" probe:
```
URL: https://<host>/api/admin/scheduled-backup
Keyword: lastSuccessAt
Heartbeat: 12 hours
```

## Restore procedure

1. Pick the dump you want. From S3:
   ```bash
   aws s3 ls s3://<bucket>/backups/                  # or `mc ls`
   aws s3 cp s3://<bucket>/backups/<file>.sql.gz .
   ```
   Or from the local volume on a still-running stack:
   ```bash
   docker compose cp api:/backups/<file>.sql.gz .
   ```

2. (Optional) drop and recreate the database to avoid `CREATE TABLE` collisions:
   ```bash
   docker compose exec postgres psql -U pipelineflow postgres \
     -c "DROP DATABASE pipelineflow;" \
     -c "CREATE DATABASE pipelineflow OWNER pipelineflow;"
   ```

3. Restore:
   ```bash
   gunzip -c <file>.sql.gz | docker compose exec -T postgres psql -U pipelineflow pipelineflow
   ```

4. After a restore, force a full s3-reconcile so any orphaned attachments registered after the dump get cleaned up: **Settings → Maintenance → Run full S3 reconcile**.

## Inspecting backups without a stack

```bash
# list local files
docker run --rm -v pipelineflow-backups:/b alpine ls -lh /b

# verify a dump's gzip integrity (fast, doesn't restore)
gunzip -t <file>.sql.gz && echo OK
```

## On-demand backup outside the worker

You don't need the worker to take a one-off dump:
```bash
docker compose exec postgres pg_dump -U pipelineflow pipelineflow | gzip > backup.sql.gz
```

## PostgreSQL version skew

The worker's runtime image installs `postgresql16-client` to match the `postgres:16-alpine` service. **If you upgrade the postgres service major version, bump the worker's client in the same commit:**

1. Edit [`apps/worker/Dockerfile`](../apps/worker/Dockerfile): change `postgresql16-client` to `postgresql17-client` (etc.).
2. Edit [`docker-compose.yml`](../docker-compose.yml): change `postgres:16-alpine` to `postgres:17-alpine`.
3. Read the postgres release notes for restore-format changes — `--format=plain` (which we use) is forward-compatible across major versions, but the major-version dump file itself can't be restored to an *older* server.

## S3-compatible providers

| Provider | Notes |
|---|---|
| AWS S3 | Default. Multipart upload above ~5MB. |
| MinIO | Works as a full drop-in. Set `S3_ENDPOINT=http://<host>:9000`. |
| Cloudflare R2 | Set `S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com`. R2 ignores `Region` but the SDK requires it set. |
| Backblaze B2 (S3 API) | Set `S3_ENDPOINT=https://s3.<region>.backblazeb2.com`. B2's multipart abort can lag — single PutObject below the part threshold (most dumps under ~5GB) is fine. |

## Troubleshooting

| Symptom | Fix |
|---|---|
| Worker logs `s3 not configured — scheduled backup is a no-op` | Set `S3_BUCKET` and `AWS_ACCESS_KEY_ID` on the worker service in `docker-compose.yml`. |
| `pg_dump: command not found` in worker logs | Worker image was built before this change. Rebuild: `docker compose build worker`. |
| `another scheduled backup is already running — skipping` | The Redis lock is held; either a previous run is still in flight or it crashed and the 6h TTL hasn't expired. Inspect /admin/queues; if stale, force-clear with `redis-cli del pf:scheduled-backup:running`. |
| S3 has the file but local does not | Old runs that were pruned locally remain in S3 until `LastModified` exceeds `BACKUP_RETAIN_DAYS`. This is intended. |
| Local has the file but S3 does not, after a successful run | The catch-up sweep on the next run will upload it. If it persists, check S3 credentials. |
