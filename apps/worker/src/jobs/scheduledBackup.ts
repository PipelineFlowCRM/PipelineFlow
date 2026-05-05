import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { PassThrough, pipeline as pipelineCb } from 'node:stream';
import { promisify } from 'node:util';
import { createGunzip, createGzip } from 'node:zlib';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import {
  type ScheduledBackupJobData,
  type ScheduledBackupJobResult,
} from '@pipelineflow/shared';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { acquireLock } from '../lib/redisLock.js';
import {
  deleteObject,
  listAllUnder,
  s3Configured,
  uploadStream,
} from '../lib/s3.js';

const pipeline = promisify(pipelineCb);

// Files we manage live under this prefix in S3. Matches the local volume
// layout 1:1 (basename of the .sql.gz file). Reconcile's SCOPES list
// deliberately excludes this prefix so its orphan-detection pass can't
// delete backups it doesn't recognise — see s3Reconcile.ts.
const S3_BACKUP_PREFIX = 'backups/';

// Filename pattern shared with apps/api/scripts/start.sh's pre-migrate
// dumps. The catch-up sweep globs on this so it picks up both
// `-pre-migrate.sql.gz` and `-scheduled.sql.gz` files.
const FILENAME_PREFIX = 'pipelineflow-';
const FILENAME_SUFFIX = '.sql.gz';

// Redis key holding the epoch-ms of the last successful run. Surfaced via
// the API for /admin/scheduled-backup status and the MaintenanceCard UI.
export const LAST_SUCCESS_KEY = 'pf:scheduled-backup:last-success';

// Soft-lock TTL: long enough to cover a worst-case slow dump on a large DB,
// short enough that a crashed worker doesn't block the next cron run.
const LOCK_TTL_MS = 6 * 60 * 60 * 1000; // 6h

const LOCK_KEY = 'pf:scheduled-backup:running';

export function makeScheduledBackupProcessor(redis: Redis) {
  return async function processScheduledBackup(
    job: Job<ScheduledBackupJobData, ScheduledBackupJobResult>,
  ): Promise<ScheduledBackupJobResult> {
    const log = logger.child({ jobId: job.id, jobName: job.name, trigger: job.data.trigger });
    const startedAt = Date.now();

    if (!s3Configured()) {
      log.warn('s3 not configured — scheduled backup is a no-op');
      return { uploaded: 0, pruned: 0, bytes: 0, durationMs: 0 };
    }

    // Soft-lock so a manual "Run now" can't overlap a cron run, and a
    // queued repeat tick that fires while one is still in flight doesn't
    // double-dump. BullMQ's repeatable jobId already coalesces the cron
    // path, but a manual trigger uses a different jobId.
    const release = await acquireLock(redis, LOCK_KEY, LOCK_TTL_MS);
    if (!release) {
      log.warn('another scheduled backup is already running — skipping');
      return { uploaded: 0, pruned: 0, bytes: 0, durationMs: 0 };
    }

    try {
      await mkdir(env.BACKUP_DIR, { recursive: true });

      const dump = await runDump(log);
      let uploaded = 0;
      let pruned = 0;

      // Upload the dump we just took. Local-first, S3-second: the file is
      // already finalised on disk before we attempt the network call, so
      // an upload failure leaves a recoverable artifact.
      try {
        await uploadFile(dump.localPath, dump.s3Key, dump.sizeBytes);
        uploaded += 1;
        log.info({ key: dump.s3Key, bytes: dump.sizeBytes }, 'uploaded fresh dump');
      } catch (err) {
        // Fail the job so BullMQ retries; the next run's catch-up sweep
        // will pick this file up regardless. We deliberately don't delete
        // the local file here — that's the safety net.
        log.error({ err, key: dump.s3Key }, 'fresh dump uploaded failed');
        throw err;
      }

      // List the S3 prefix once and share the result across catch-up and
      // prune — both phases need it, and on a long-lived deploy the bucket
      // listing is the most expensive S3 op we make per run.
      const s3Inventory = await listBackupsInventory();

      // Catch-up sweep: any local file (including pre-migrate dumps from
      // the api container) that isn't already in S3 gets pushed now. This
      // is the "no manual rsync" outcome the issue calls for.
      const swept = await catchUpSweep(log, s3Inventory.keys);
      uploaded += swept;

      // Retention: prune both stores in lockstep. Keeps S3 bills bounded
      // and the Docker volume from filling on a long-lived host.
      pruned = await pruneOld(log, s3Inventory.entries);

      await redis.set(LAST_SUCCESS_KEY, String(Date.now()));

      const result: ScheduledBackupJobResult = {
        uploaded,
        pruned,
        bytes: dump.sizeBytes,
        durationMs: Date.now() - startedAt,
      };
      log.info(result, 'scheduled backup completed');
      return result;
    } finally {
      await release();
    }
  };
}

interface DumpOutcome {
  localPath: string;
  s3Key: string;
  sizeBytes: number;
}

/**
 * Run pg_dump, pipe through gzip, and write to a uniquely-named local file.
 * Filename includes hostname + pid so a pathological double-run (lock
 * miss) can't collide. stderr is captured and logged at debug — pg_dump
 * is chatty about NOTICE output even on success.
 */
async function runDump(log: Logger): Promise<DumpOutcome> {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  // Sanitise hostname — it ends up in a filename and (more importantly) an
  // S3 key, where slashes would create false sub-prefixes.
  const host = hostname().replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 32) || 'worker';
  const basename = `${FILENAME_PREFIX}${ts}-${host}-${process.pid}-scheduled${FILENAME_SUFFIX}`;
  const localPath = path.join(env.BACKUP_DIR, basename);

  log.info({ localPath }, 'starting pg_dump');

  // Pass connection params via libpq env vars rather than `--dbname=$URL` so
  // the password doesn't end up in /proc/<pid>/cmdline (visible to anything
  // sharing the PID namespace; readable from `ps aux`-style tools). Falling
  // back to `--dbname=` would still work but unnecessarily widens the
  // password's exposure surface.
  const pgEnv = pgEnvFromUrl(env.DATABASE_URL);

  // --no-owner / --no-acl mirrors apps/api/scripts/start.sh so the two
  // dump flavours stay restorable the same way. --format=plain keeps
  // dumps portable across pg_restore versions.
  const child = spawn(
    'pg_dump',
    ['--no-owner', '--no-acl', '--format=plain'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...pgEnv },
    },
  );

  // Capture stderr but never log the raw line at info — libpq error
  // messages can echo connection params (including the password). Pino's
  // default redaction list won't catch this. Buffer it for the failure
  // path only.
  const stderrChunks: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  const exit = new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });

  const gzip = createGzip({ level: 9 });
  const out = createWriteStream(localPath);

  // Piping pg_dump.stdout → gzip → file. Errors on any leg propagate so
  // we don't silently produce a truncated .gz.
  const pumped = pipeline(child.stdout, gzip, out);

  let exitCode: number;
  try {
    [exitCode] = await Promise.all([exit, pumped]);
  } catch (err) {
    // Best-effort: kill pg_dump if it's still running, then remove the
    // partial file so the catch-up sweep doesn't try to upload it.
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    await unlink(localPath).catch(() => {});
    throw err;
  }

  if (exitCode !== 0) {
    await unlink(localPath).catch(() => {});
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    // Log the *length* of stderr at error level; the full body goes
    // through a redacted child logger so a stray DATABASE_URL leak
    // doesn't end up in production logs.
    log.error({ exitCode, stderrBytes: stderr.length }, 'pg_dump exited non-zero');
    throw new Error(`pg_dump failed with exit code ${exitCode}`);
  }

  // Verify the gzip is well-formed before declaring success — catches
  // the case where pg_dump exited 0 but the pipe was severed mid-stream.
  // A truncated .gz would silently break a future restore.
  await verifyGzip(localPath);

  // Surface the byte count of pg_dump's stderr at debug — Postgres
  // NOTICE output (excluded extensions, search_path warnings, etc.)
  // lands here on a successful run. Logging the body would risk leaking
  // connection params if libpq ever surfaces them; logging the count is
  // enough to know there *was* something to look at.
  const stderrBytes = stderrChunks.reduce((sum, c) => sum + c.length, 0);
  if (stderrBytes > 0) log.debug({ stderrBytes }, 'pg_dump stderr (truncated)');

  const { size } = await stat(localPath);
  return { localPath, s3Key: `${S3_BACKUP_PREFIX}${path.basename(localPath)}`, sizeBytes: size };
}

/**
 * Read the gzip file end-to-end through a decompressor and discard the
 * output. zlib raises an error if the trailing CRC / ISIZE don't match —
 * exactly what we want to detect a truncated dump that pg_dump exited
 * cleanly on but the pipe didn't fully drain. Exported so the test suite
 * can hit it directly with synthetic truncated files.
 */
export async function verifyGzip(filePath: string): Promise<void> {
  const src = createReadStream(filePath);
  const sink = new PassThrough();
  sink.resume();
  await pipeline(src, createGunzip(), sink);
}

/**
 * Translate a postgres connection URL into the libpq env-var set that
 * pg_dump/psql honour. Returning an env object (rather than mutating
 * process.env) keeps the override scoped to the spawned child.
 *
 * URL-decoding matters: zod accepts URL-safe encoded passwords in
 * DATABASE_URL, but libpq expects the *decoded* PGPASSWORD value.
 */
export function pgEnvFromUrl(databaseUrl: string): NodeJS.ProcessEnv {
  const url = new URL(databaseUrl);
  const out: NodeJS.ProcessEnv = {};
  if (url.hostname) out.PGHOST = url.hostname;
  if (url.port) out.PGPORT = url.port;
  if (url.username) out.PGUSER = decodeURIComponent(url.username);
  if (url.password) out.PGPASSWORD = decodeURIComponent(url.password);
  // pathname is `/dbname` — strip the leading slash. Empty pathname falls
  // through to libpq's default (the user's role name), which matches the
  // behaviour we'd get from `--dbname=postgresql://...`.
  const dbname = url.pathname.replace(/^\//, '');
  if (dbname) out.PGDATABASE = decodeURIComponent(dbname);
  // sslmode is the most common URL search param worth forwarding. Leave
  // others alone — libpq will read them from PGOPTIONS if needed and the
  // app DATABASE_URL doesn't currently use them.
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode) out.PGSSLMODE = sslmode;
  return out;
}

async function uploadFile(
  localPath: string,
  s3Key: string,
  sizeBytes: number,
): Promise<void> {
  const body = createReadStream(localPath);
  await uploadStream(s3Key, body, 'application/gzip', {
    sizeBytes: String(sizeBytes),
    dumpedAt: new Date().toISOString(),
  });
}

/**
 * List everything in /backups that matches the dump filename pattern,
 * compare against the S3 prefix, and upload anything missing. Picks up:
 *   - Pre-migrate dumps from apps/api/scripts/start.sh (file suffix
 *     `-pre-migrate.sql.gz`)
 *   - Failed-upload leftovers from prior scheduled runs
 *
 * Files newer than 60s are skipped to avoid racing with a still-writing
 * dump (we don't expect this in practice — the fresh dump path is
 * sequential — but it's free insurance against a future code path that
 * writes asynchronously).
 */
async function catchUpSweep(log: Logger, inS3: Set<string>): Promise<number> {
  let uploaded = 0;
  const localFiles = await listLocalDumps();
  const now = Date.now();

  for (const file of localFiles) {
    const key = `${S3_BACKUP_PREFIX}${file.basename}`;
    if (inS3.has(key)) continue;
    if (now - file.mtimeMs < 60_000) {
      log.debug({ basename: file.basename }, 'skipping freshly-written file in catch-up');
      continue;
    }
    try {
      const body = createReadStream(file.path);
      await uploadStream(key, body, 'application/gzip', {
        sizeBytes: String(file.sizeBytes),
        dumpedAt: new Date(file.mtimeMs).toISOString(),
        catchUp: 'true',
      });
      uploaded += 1;
      log.info({ key, bytes: file.sizeBytes }, 'catch-up uploaded local file');
    } catch (err) {
      // One bad file shouldn't block the rest of the sweep — log and move
      // on. The next run will retry.
      log.warn({ err, basename: file.basename }, 'catch-up upload failed');
    }
  }
  return uploaded;
}

interface LocalDump {
  path: string;
  basename: string;
  sizeBytes: number;
  mtimeMs: number;
}

async function listLocalDumps(): Promise<LocalDump[]> {
  let names: string[];
  try {
    names = await readdir(env.BACKUP_DIR);
  } catch {
    // Directory missing is fine on a fresh boot — it'll be created on the
    // next dump.
    return [];
  }
  const out: LocalDump[] = [];
  for (const name of names) {
    if (!name.startsWith(FILENAME_PREFIX) || !name.endsWith(FILENAME_SUFFIX)) continue;
    const full = path.join(env.BACKUP_DIR, name);
    try {
      const s = await stat(full);
      if (!s.isFile()) continue;
      out.push({ path: full, basename: name, sizeBytes: s.size, mtimeMs: s.mtimeMs });
    } catch {
      // File vanished mid-readdir — skip.
    }
  }
  return out;
}

interface S3InventoryEntry {
  key: string;
  lastModifiedMs: number;
}

interface S3Inventory {
  // Set of every key currently under `backups/` — lookup-friendly for
  // catch-up's "is this already in S3?" check.
  keys: Set<string>;
  // Same data with LastModified attached, for the prune phase. Both
  // shapes are derived from a single ListObjectsV2 pass so a long-lived
  // deploy with thousands of dumps doesn't pay for two paginated lists.
  entries: S3InventoryEntry[];
}

async function listBackupsInventory(): Promise<S3Inventory> {
  const keys = new Set<string>();
  const entries: S3InventoryEntry[] = [];
  await listAllUnder(S3_BACKUP_PREFIX, (obj) => {
    if (!obj.Key) return;
    keys.add(obj.Key);
    entries.push({
      key: obj.Key,
      lastModifiedMs: obj.LastModified?.getTime() ?? 0,
    });
  });
  return { keys, entries };
}

/**
 * Delete files (local) and objects (S3) older than BACKUP_RETAIN_DAYS.
 * Uses S3 LastModified rather than parsing the filename so a manually
 * uploaded backup with a non-standard name still ages out predictably.
 */
async function pruneOld(log: Logger, s3Entries: S3InventoryEntry[]): Promise<number> {
  const cutoff = Date.now() - env.BACKUP_RETAIN_DAYS * 24 * 60 * 60 * 1000;
  let pruned = 0;

  // Local prune
  for (const file of await listLocalDumps()) {
    if (file.mtimeMs >= cutoff) continue;
    try {
      await unlink(file.path);
      pruned += 1;
      log.info({ basename: file.basename }, 'pruned old local backup');
    } catch (err) {
      log.warn({ err, basename: file.basename }, 'local prune failed');
    }
  }

  // S3 prune — work from the inventory the caller gathered earlier so we
  // don't re-list. Note: the fresh dump we just uploaded is included in
  // s3Entries, but its LastModified is "now" so the cutoff filter
  // correctly skips it.
  for (const entry of s3Entries) {
    if (entry.lastModifiedMs <= 0 || entry.lastModifiedMs >= cutoff) continue;
    try {
      await deleteObject(entry.key);
      pruned += 1;
      log.info({ key: entry.key }, 'pruned old s3 backup');
    } catch (err) {
      log.warn({ err, key: entry.key }, 's3 prune failed');
    }
  }

  return pruned;
}
