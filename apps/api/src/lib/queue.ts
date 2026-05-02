import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import {
  QUEUE_GENERATE,
  QUEUE_S3_CLEANUP,
  QUEUE_S3_RECONCILE,
  QUEUE_WEBHOOK_DELIVERY,
  type GenerateJobData,
  type GenerateJobResult,
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

export const allQueues = [
  generateQueue,
  webhookDeliveryQueue,
  s3CleanupQueue,
  s3ReconcileQueue,
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
