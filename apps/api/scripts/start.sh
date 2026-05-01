#!/bin/sh
# API container entrypoint.
#
# Order of operations on every container start:
#   1. Take a gzipped pg_dump if there are pending migrations.
#   2. Apply pending migrations (`prisma migrate deploy`).
#   3. Start the API.
#
# Backing up only when migrations are pending keeps ordinary container
# restarts (crash recovery, host reboot) from filling the backup volume —
# but every real deploy that ships schema changes gets a pre-migrate dump.
#
# Backups are written to /backups/pipelineflow-<UTC-ISO>-pre-migrate.sql.gz
# and pruned after BACKUP_RETAIN_DAYS (default 30). Mount /backups to a
# named volume or host path you can rsync off-host.

set -eu
# pipefail catches `pg_dump | gzip` where pg_dump fails but gzip happily
# produces an empty .gz. BusyBox ash supports it.
set -o pipefail

cd /app/apps/api

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-30}"

# `prisma migrate status` exits 0 when in sync, non-0 when there are
# pending or failed migrations. We only want a backup when there's
# something new to apply — but if status itself fails (e.g. unreachable
# DB), bail before we try to back up or migrate.
status_output=$(pnpm exec prisma migrate status 2>&1) && status_rc=0 || status_rc=$?

if [ "$status_rc" -eq 0 ]; then
  echo "[start] schema already up to date — skipping pre-migrate backup"
elif echo "$status_output" | grep -qiE 'have not yet been applied|following migration'; then
  mkdir -p "$BACKUP_DIR"

  # Debounce: if the migration fails and Docker restarts the container under
  # `unless-stopped`, every retry would otherwise dump the DB again until
  # BACKUP_RETAIN_DAYS pruned them — easy to fill the volume in hours on a
  # busy DB. Skip the dump if a marker exists from < ${BACKUP_DEBOUNCE_SEC}
  # seconds ago. The marker is cleared after a successful migrate so a real
  # follow-up deploy still gets a fresh dump.
  BACKUP_DEBOUNCE_SEC="${BACKUP_DEBOUNCE_SEC:-300}"
  marker="${BACKUP_DIR}/.last-pre-migrate-attempt"
  now_epoch=$(date -u +%s)
  if [ -f "$marker" ]; then
    last_epoch=$(cat "$marker" 2>/dev/null || echo 0)
    age=$((now_epoch - last_epoch))
    if [ "$age" -ge 0 ] && [ "$age" -lt "$BACKUP_DEBOUNCE_SEC" ]; then
      echo "[start] pending migrations detected, but a backup attempt happened ${age}s ago (< ${BACKUP_DEBOUNCE_SEC}s) — skipping dump"
      skip_dump=1
    fi
  fi

  if [ "${skip_dump:-0}" -ne 1 ]; then
    ts=$(date -u +%Y%m%dT%H%M%SZ)
    out="${BACKUP_DIR}/pipelineflow-${ts}-pre-migrate.sql.gz"
    echo "[start] pending migrations detected — dumping DB to ${out}"

    # Write the marker BEFORE dumping so a crash mid-dump still debounces
    # subsequent attempts (otherwise a hard crash loop could still pile up
    # partial files on the volume — though pipefail + the rm-on-failure
    # below also clean those up).
    echo "$now_epoch" > "$marker"

    # pg_dump reads connection params from DATABASE_URL via the libpq
    # `--dbname=` form. --no-owner / --no-acl keep dumps portable across
    # users (so a fresh DB or a different role can restore cleanly).
    if pg_dump --dbname="$DATABASE_URL" --no-owner --no-acl --format=plain \
        | gzip -9 > "$out"; then
      echo "[start] backup complete ($(du -h "$out" | cut -f1))"
    else
      echo "[start] pg_dump FAILED — refusing to migrate" >&2
      rm -f "$out"
      exit 1
    fi

    # Prune old backups. -mtime +N matches files older than N*24h.
    find "$BACKUP_DIR" -maxdepth 1 -name 'pipelineflow-*.sql.gz' -type f \
      -mtime "+${BACKUP_RETAIN_DAYS}" -print -delete || true
  fi
else
  echo "[start] prisma migrate status returned ${status_rc}:" >&2
  echo "$status_output" >&2
  exit "$status_rc"
fi

echo "[start] applying migrations"
pnpm exec prisma migrate deploy

# Clear the debounce marker so a *future* deploy that ships new schema
# changes will get its own pre-migrate dump (rather than being suppressed
# by an old marker from this successful run).
rm -f "${BACKUP_DIR}/.last-pre-migrate-attempt" 2>/dev/null || true

echo "[start] starting API"
exec node dist/index.js
