import type { Job, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  S3Client,
  ListObjectsV2Command,
  type _Object,
} from '@aws-sdk/client-s3';
import {
  QUEUE_S3_CLEANUP,
  type S3CleanupJobData,
  type S3CleanupJobResult,
  type S3ReconcileJobData,
  type S3ReconcileJobResult,
} from '@pipelineflow/shared';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { prisma } from '../db.js';

const s3 = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT || undefined,
  forcePathStyle: !!env.S3_ENDPOINT,
  credentials:
    env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        }
      : undefined,
});

const s3Configured = () => !!env.S3_BUCKET && !!env.AWS_ACCESS_KEY_ID;

// Keys younger than this aren't considered orphans yet — there's a real
// window between presigned-PUT success and the /attachments registration
// call, and we don't want a slow client to lose its file mid-upload.
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

// Hard cap so a runaway scan can't pile a million keys into a single
// cleanup job. Each cleanup job processes its keys one-by-one, so this
// is also the per-job time budget proxy.
const MAX_ORPHANS_PER_BATCH = 200;

// Redis key tracking the last successful reconcile timestamp (epoch ms).
// Delete this key to force a full bucket re-scan on the next run — useful
// after a DB restore or when investigating drift the incremental path
// can't catch on its own.
const STATE_KEY = 'pf:s3-reconcile:last';

const SCOPES = ['attachment/', 'avatar/', 'logo/'] as const;

/**
 * The worker queue handle is passed in so the reconcile job can enqueue
 * cleanup work into the same Redis we're already connected to. We also
 * piggy-back on that Redis connection to persist the last-checked
 * timestamp — no migration, no extra dependency.
 */
export function makeReconcileProcessor(
  cleanupQueue: Queue<S3CleanupJobData, S3CleanupJobResult>,
  redis: Redis,
) {
  return async function processS3Reconcile(
    job: Job<S3ReconcileJobData, S3ReconcileJobResult>,
  ): Promise<S3ReconcileJobResult> {
    const log = logger.child({ jobId: job.id, jobName: job.name });

    if (!s3Configured()) {
      log.warn('s3 not configured — reconcile is a no-op');
      return { scanned: 0, orphaned: 0 };
    }

    const startedAt = Date.now();
    const forceFull = job.data.forceFull === true;
    // `forceFull` shortcuts the high-water-mark read so the Maintenance
    // button always produces a full scan — even if a daily run is mid-flight
    // and would otherwise write a fresh `lastChecked` after this job is
    // queued (which would defeat the force).
    const lastChecked = forceFull ? null : await loadLastChecked(redis);
    // The window we need to (re-)scan: from `lastChecked - grace` (so a key
    // that was inside the grace window on the previous run gets re-evaluated
    // now that it's aged out) up through today. If we've never run, fall
    // back to a full scan — the only time we list every key in the bucket.
    const dateRange = lastChecked
      ? utcDateRange(new Date(lastChecked.getTime() - ORPHAN_GRACE_MS), new Date(startedAt))
      : null;

    const cutoff = startedAt - ORPHAN_GRACE_MS;
    const inUse = await loadInUseKeys();
    let scanned = 0;
    let orphanedTotal = 0;
    const orphans: string[] = [];

    const flushOrphans = async () => {
      if (orphans.length === 0) return;
      orphanedTotal += orphans.length;
      await cleanupQueue.add(QUEUE_S3_CLEANUP, { keys: orphans.splice(0) });
    };

    const consumeKey = async (obj: _Object) => {
      const key = obj.Key;
      if (!key) return;
      scanned += 1;
      if (inUse.has(key)) return;
      const lastModified = obj.LastModified?.getTime() ?? 0;
      if (lastModified > cutoff) return;
      orphans.push(key);
      if (orphans.length >= MAX_ORPHANS_PER_BATCH) {
        await flushOrphans();
      }
    };

    if (dateRange == null) {
      // First-run / catch-up: scan every key under each managed prefix.
      log.info('no prior reconcile — running full bucket scan');
      for (const prefix of SCOPES) {
        await listAllUnder(prefix, consumeKey);
      }
    } else {
      // Incremental: only list the date-partitioned sub-prefixes that
      // could contain new (or newly-aged-past-grace) orphans. For a daily
      // run this is typically 1–2 dates per scope.
      log.info(
        { from: dateRange[0], to: dateRange[dateRange.length - 1], scopes: SCOPES.length },
        'running incremental reconcile',
      );
      for (const scope of SCOPES) {
        for (const date of dateRange) {
          await listAllUnder(`${scope}${date}/`, consumeKey);
        }
      }
    }

    await flushOrphans();

    // Only persist the high-water mark on a clean run. If the processor
    // throws partway, BullMQ's retry will repeat the same window — orphan
    // cleanup is idempotent so re-enqueueing the same key is harmless.
    await saveLastChecked(redis, new Date(startedAt));

    log.info(
      {
        scanned,
        orphaned: orphanedTotal,
        mode: dateRange ? 'incremental' : 'full',
        windowDays: dateRange?.length ?? null,
      },
      's3 reconcile finished',
    );
    return { scanned, orphaned: orphanedTotal };
  };
}

async function listAllUnder(prefix: string, consume: (o: _Object) => Promise<void>) {
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: env.S3_BUCKET,
        Prefix: prefix,
        ContinuationToken: token,
        MaxKeys: 1000,
      }),
    );
    for (const obj of page.Contents ?? []) {
      await consume(obj);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
}

/**
 * Inclusive list of UTC dates (YYYY-MM-DD) covered by [from, to]. Matches
 * the `buildKey` partitioning scheme — keys are bucketed by `new Date()
 * .toISOString().slice(0, 10)` at upload time, which is UTC.
 */
function utcDateRange(from: Date, to: Date): string[] {
  const out: string[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  while (cursor <= end) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

async function loadLastChecked(redis: Redis): Promise<Date | null> {
  const raw = await redis.get(STATE_KEY);
  if (!raw) return null;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
}

async function saveLastChecked(redis: Redis, when: Date): Promise<void> {
  await redis.set(STATE_KEY, String(when.getTime()));
}

/**
 * Snapshot of every S3 key the application currently considers in-use:
 *   - Attachment.storedKey (always a key, never an http URL)
 *   - User.avatarUrl       (only when it's a key — http URLs are skipped)
 *   - Company.logoUrl      (same)
 * Returned as a Set for O(1) membership checks during the bucket scan.
 */
async function loadInUseKeys(): Promise<Set<string>> {
  const [attachments, users, companies] = await Promise.all([
    prisma.attachment.findMany({ select: { storedKey: true } }),
    prisma.user.findMany({
      where: { avatarUrl: { not: null } },
      select: { avatarUrl: true },
    }),
    prisma.company.findMany({
      where: { logoUrl: { not: null } },
      select: { logoUrl: true },
    }),
  ]);
  const set = new Set<string>();
  for (const a of attachments) set.add(a.storedKey);
  for (const u of users) {
    if (u.avatarUrl && !/^https?:\/\//i.test(u.avatarUrl)) set.add(u.avatarUrl);
  }
  for (const c of companies) {
    if (c.logoUrl && !/^https?:\/\//i.test(c.logoUrl)) set.add(c.logoUrl);
  }
  return set;
}
