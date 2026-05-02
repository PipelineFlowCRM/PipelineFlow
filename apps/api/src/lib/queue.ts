import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import {
  QUEUE_GENERATE,
  QUEUE_GOOGLE_CONTACTS_PULL,
  QUEUE_GOOGLE_CONTACTS_PUSH,
  QUEUE_S3_CLEANUP,
  QUEUE_S3_RECONCILE,
  QUEUE_WEBHOOK_DELIVERY,
  type GenerateJobData,
  type GenerateJobResult,
  type GoogleContactsPullJobData,
  type GoogleContactsPullJobResult,
  type GoogleContactsPushJobData,
  type GoogleContactsPushJobResult,
  type S3CleanupJobData,
  type S3CleanupJobResult,
  type S3ReconcileJobData,
  type S3ReconcileJobResult,
  type WebhookDeliveryJobData,
  type WebhookDeliveryJobResult,
} from '@pipelineflow/shared';
import { env } from '../env.js';
import { logger } from './logger.js';

// BullMQ requires `maxRetriesPerRequest: null` on its connection — its
// blocking commands need to wait indefinitely. Keepalive trims idle
// disconnects on managed Redis providers.
export const redisConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

redisConnection.on('error', (err: Error) => {
  logger.error({ err }, 'redis connection error');
});

const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  // Cap retained jobs so Redis doesn't grow unbounded. Failures are kept
  // longer so we can inspect them via /admin/queues.
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 86_400 },
};

export const generateQueue = new Queue<GenerateJobData, GenerateJobResult>(QUEUE_GENERATE, {
  connection: redisConnection,
  defaultJobOptions,
});

// Webhook delivery uses a custom-name backoff strategy registered on the
// Worker side (see apps/worker/src/index.ts) — we just reference it here
// by name. Total budget across 8 attempts: ~8h, with the gaps starting at
// 30s so a flaky 5xx doesn't burn a full minute before the first retry.
const webhookDeliveryJobOptions: JobsOptions = {
  attempts: 8,
  backoff: { type: 'webhookDelivery' },
  // Keep success rows briefly (the delivery-log table is the durable record);
  // failures stay longer so /admin/queues remains debuggable.
  removeOnComplete: { age: 3_600, count: 5_000 },
  removeOnFail: { age: 7 * 86_400 },
};

export const webhookDeliveryQueue = new Queue<WebhookDeliveryJobData, WebhookDeliveryJobResult>(
  QUEUE_WEBHOOK_DELIVERY,
  {
    connection: redisConnection,
    defaultJobOptions: webhookDeliveryJobOptions,
  },
);

// S3 deletes are individually idempotent (DeleteObject on a missing key is a
// 204), so the default 3-attempts-with-exponential-backoff is fine — no need
// for a custom strategy. Failures stick around in /admin/queues so an op can
// inspect the bucket if a region outage drops a batch.
export const s3CleanupQueue = new Queue<S3CleanupJobData, S3CleanupJobResult>(
  QUEUE_S3_CLEANUP,
  {
    connection: redisConnection,
    defaultJobOptions,
  },
);

// Reconcile uses a single `attempts` since it's idempotent and we'd rather
// the *next* run pick up any drift than retry a failing scan twice in a row.
const s3ReconcileJobOptions: JobsOptions = {
  attempts: 1,
  removeOnComplete: { age: 7 * 86_400, count: 30 },
  removeOnFail: { age: 7 * 86_400 },
};

export const s3ReconcileQueue = new Queue<S3ReconcileJobData, S3ReconcileJobResult>(
  QUEUE_S3_RECONCILE,
  {
    connection: redisConnection,
    defaultJobOptions: s3ReconcileJobOptions,
  },
);

// Google Contacts pull / push. Both share the default backoff because People
// API errors fall into two clean buckets: rate limits (we surface the
// server-suggested Retry-After via DelayedError on the worker side) and
// genuinely unexpected failures (re-try once or twice and let the next cron
// catch up). Retention defaults are slightly longer than the generic queues
// — sync regressions are easier to diagnose with a week of history in
// /admin/queues.
const googleContactsJobOptions: JobsOptions = {
  attempts: 4,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: { age: 86_400, count: 1_000 },
  removeOnFail: { age: 7 * 86_400 },
};

export const googleContactsPullQueue = new Queue<
  GoogleContactsPullJobData,
  GoogleContactsPullJobResult
>(QUEUE_GOOGLE_CONTACTS_PULL, {
  connection: redisConnection,
  defaultJobOptions: googleContactsJobOptions,
});

export const googleContactsPushQueue = new Queue<
  GoogleContactsPushJobData,
  GoogleContactsPushJobResult
>(QUEUE_GOOGLE_CONTACTS_PUSH, {
  connection: redisConnection,
  defaultJobOptions: googleContactsJobOptions,
});

export const allQueues = [
  generateQueue,
  webhookDeliveryQueue,
  s3CleanupQueue,
  s3ReconcileQueue,
  googleContactsPullQueue,
  googleContactsPushQueue,
];

export async function enqueueGenerate(data: GenerateJobData) {
  return generateQueue.add(QUEUE_GENERATE, data);
}

export async function enqueueWebhookDelivery(data: WebhookDeliveryJobData) {
  return webhookDeliveryQueue.add(QUEUE_WEBHOOK_DELIVERY, data);
}

export async function enqueueS3Cleanup(data: S3CleanupJobData) {
  if (data.keys.length === 0) return null;
  // Swallow + log Redis enqueue failures rather than letting the caller
  // 500. Every callsite runs *after* the user-visible mutation has
  // committed (delete deal, replace avatar, etc.), so a 500 here would
  // misrepresent the actual outcome and leave the user re-attempting a
  // delete that already succeeded. Reconcile is the safety net — orphans
  // get reaped on the next sweep.
  try {
    return await s3CleanupQueue.add(QUEUE_S3_CLEANUP, data);
  } catch (err) {
    logger.error(
      { err, count: data.keys.length },
      'failed to enqueue s3 cleanup; reconcile will reap',
    );
    return null;
  }
}

/**
 * Registers a daily repeatable reconcile job. BullMQ deduplicates repeatables
 * by name + repeat config, so calling this on every api boot is safe — it
 * either creates the schedule or no-ops. We pin a key so a future change in
 * cadence cleanly replaces the old schedule (otherwise the old one lingers).
 */
export async function ensureS3ReconcileScheduled() {
  // 03:17 UTC daily — a quiet hour offset by a few minutes so a fleet of
  // services scheduled at top-of-hour doesn't collide on Redis.
  await s3ReconcileQueue.add(
    QUEUE_S3_RECONCILE,
    {},
    {
      repeat: { pattern: '17 3 * * *' },
      jobId: 'recurring:s3-reconcile:daily',
    },
  );
}

export async function triggerS3ReconcileNow() {
  return s3ReconcileQueue.add(QUEUE_S3_RECONCILE, {});
}

// ─── Google Contacts producers ──────────────────────────────────────────────

export async function enqueueGoogleContactsPull(data: GoogleContactsPullJobData) {
  return googleContactsPullQueue.add(QUEUE_GOOGLE_CONTACTS_PULL, data, {
    // jobId pinning so a manual "Resync now" while a cron run is queued
    // collapses into one job per account. The worker enforces per-account
    // serial execution on top of this — see apps/worker/src/index.ts.
    jobId: `google-contacts-pull:${data.kind}:${data.googleAccountId}`,
  });
}

export async function enqueueGoogleContactsPush(data: GoogleContactsPushJobData) {
  // Push jobs aren't dedup-keyed: a contact edited twice in quick
  // succession should produce two jobs (the second wins on echo-hash
  // anyway, but a missed enqueue is worse than a redundant one). The
  // helper at integrations/google/enqueuePushIfConnected.ts is responsible
  // for skipping the enqueue when no account has outbound enabled.
  try {
    return await googleContactsPushQueue.add(QUEUE_GOOGLE_CONTACTS_PUSH, data);
  } catch (err) {
    logger.error({ err, data }, 'failed to enqueue google-contacts-push');
    return null;
  }
}

/**
 * Schedules the per-account incremental pull cron. Idempotent — calling
 * this for the same account on every api boot is a no-op once registered.
 * Safe to call when the user (re)connects an account.
 *
 * The interval is configurable via env so a homelab can dial it up to keep
 * Redis quiet, and a hosted deploy can dial it down for tighter sync.
 */
export async function ensureGoogleContactsPullScheduled(googleAccountId: number) {
  const intervalMs = env.GOOGLE_CONTACTS_SYNC_INTERVAL_MS;
  await googleContactsPullQueue.add(
    QUEUE_GOOGLE_CONTACTS_PULL,
    { kind: 'incremental', googleAccountId },
    {
      repeat: { every: intervalMs },
      jobId: `recurring:google-contacts-pull:${googleAccountId}`,
    },
  );
}

/**
 * Removes the recurring schedule for an account — call when the user
 * disconnects. BullMQ's repeatable-removal API has shifted across
 * versions and the (name, opts, jobId) overload silently no-ops on
 * minor mismatches. Listing + matching by jobId is the version-stable
 * path: once we have the repeatable's `key`, removeRepeatableByKey
 * always works.
 */
export async function unscheduleGoogleContactsPull(googleAccountId: number) {
  const wantedId = `recurring:google-contacts-pull:${googleAccountId}`;
  const repeatables = await googleContactsPullQueue.getRepeatableJobs();
  const target = repeatables.find((r) => r.id === wantedId);
  if (!target) {
    logger.warn(
      { googleAccountId, wantedId },
      'no matching repeatable to unschedule (already gone?)',
    );
    return;
  }
  await googleContactsPullQueue.removeRepeatableByKey(target.key);
}

/**
 * Force a *full* bucket scan on the next reconcile run. Encodes the intent
 * as a job-data flag rather than mutating shared Redis state: a forced run
 * queued while a daily run is in flight would previously be defeated by
 * the daily run writing its own high-water mark on completion. Returns the
 * enqueued job id so the caller can link to it in /admin/queues.
 */
export async function forceFullS3Reconcile(): Promise<string> {
  const job = await s3ReconcileQueue.add(QUEUE_S3_RECONCILE, { forceFull: true });
  return String(job.id);
}

export async function closeQueues() {
  await Promise.allSettled(allQueues.map((q) => q.close()));
  await redisConnection.quit().catch(() => {
    // quit() rejects if already disconnected — harmless during shutdown.
  });
}
