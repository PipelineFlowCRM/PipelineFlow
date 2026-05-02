import { Worker } from 'bullmq';
import {
  QUEUE_GENERATE,
  QUEUE_S3_CLEANUP,
  QUEUE_S3_RECONCILE,
  QUEUE_WEBHOOK_DELIVERY,
} from '@pipelineflow/shared';
import { env } from './env.js';
import { logger } from './logger.js';
import { redisConnection, s3CleanupProducer } from './queue.js';
import { prisma } from './db.js';
import { processGenerate } from './jobs/generate.js';
import { processS3Cleanup } from './jobs/s3Cleanup.js';
import { makeReconcileProcessor } from './jobs/s3Reconcile.js';
import {
  processWebhookDelivery,
  webhookDeliveryBackoffStrategy,
} from './jobs/webhookDelivery.js';
import { startHealthServer } from './health.js';

const generateWorker = new Worker(QUEUE_GENERATE, processGenerate, {
  connection: redisConnection,
  concurrency: env.WORKER_CONCURRENCY,
});

generateWorker.on('completed', (job) => {
  logger.debug({ jobId: job.id }, 'job completed');
});
generateWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, 'job failed');
});
// Connection-level errors (ioredis hiccups, timeouts). Without this listener
// BullMQ's emitted 'error' becomes an unhandled event.
generateWorker.on('error', (err) => {
  logger.error({ err }, 'worker error');
});

// Webhook delivery: registers the custom backoff strategy keyed by name so
// the api side's `backoff: { type: 'webhookDelivery' }` resolves to our
// staircase schedule. Concurrency is shared with the env-wide setting —
// flaky endpoints can pin slots, so consider tuning this independently if
// fan-out volume grows.
const webhookDeliveryWorker = new Worker(
  QUEUE_WEBHOOK_DELIVERY,
  processWebhookDelivery,
  {
    connection: redisConnection,
    concurrency: env.WORKER_CONCURRENCY,
    settings: {
      backoffStrategy: webhookDeliveryBackoffStrategy,
    },
  },
);

webhookDeliveryWorker.on('completed', (job) => {
  logger.debug({ jobId: job.id }, 'webhook delivery completed');
});
webhookDeliveryWorker.on('failed', (job, err) => {
  // The processor itself owns the auto-disable and delivery-row bookkeeping
  // — this listener exists for telemetry only.
  logger.warn(
    { jobId: job?.id, deliveryId: job?.data?.deliveryId, err: err.message },
    'webhook delivery attempt failed',
  );
});
webhookDeliveryWorker.on('error', (err) => {
  logger.error({ err }, 'webhook delivery worker error');
});

const s3CleanupWorker = new Worker(QUEUE_S3_CLEANUP, processS3Cleanup, {
  connection: redisConnection,
  concurrency: env.WORKER_CONCURRENCY,
});

s3CleanupWorker.on('completed', (job) => {
  logger.debug({ jobId: job.id }, 's3 cleanup completed');
});
s3CleanupWorker.on('failed', (job, err) => {
  logger.warn(
    { jobId: job?.id, count: job?.data?.keys?.length, err: err.message },
    's3 cleanup attempt failed',
  );
});
s3CleanupWorker.on('error', (err) => {
  logger.error({ err }, 's3 cleanup worker error');
});

// Concurrency 1 — reconcile is a single bucket-wide scan and there's no
// benefit (and small cost) to running two simultaneously.
const s3ReconcileWorker = new Worker(
  QUEUE_S3_RECONCILE,
  makeReconcileProcessor(s3CleanupProducer, redisConnection),
  { connection: redisConnection, concurrency: 1 },
);

s3ReconcileWorker.on('completed', (job, result) => {
  logger.info(
    { jobId: job.id, scanned: result?.scanned, orphaned: result?.orphaned },
    's3 reconcile completed',
  );
});
s3ReconcileWorker.on('failed', (job, err) => {
  logger.warn({ jobId: job?.id, err: err.message }, 's3 reconcile failed');
});
s3ReconcileWorker.on('error', (err) => {
  logger.error({ err }, 's3 reconcile worker error');
});

const healthServer = startHealthServer();

logger.info(
  { concurrency: env.WORKER_CONCURRENCY, env: env.NODE_ENV },
  'PipelineFlow worker started',
);

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  // worker.close() waits for in-flight jobs (up to the queue's lock timeout)
  // before resolving — that's the whole point of running a worker out of
  // process. Close it first so we don't disconnect Redis mid-job.
  try {
    await Promise.allSettled([
      generateWorker.close(),
      webhookDeliveryWorker.close(),
      s3CleanupWorker.close(),
      s3ReconcileWorker.close(),
      s3CleanupProducer.close(),
    ]);
  } catch (err) {
    logger.error({ err }, 'error closing worker');
  }
  try {
    await redisConnection.quit();
  } catch {
    // already disconnected — fine
  }
  try {
    await prisma.$disconnect();
  } catch (err) {
    logger.error({ err }, 'error disconnecting prisma');
  }
  healthServer.close(() => process.exit(0));
  setTimeout(() => {
    logger.warn('forced exit after 15s grace');
    process.exit(1);
  }, 15_000).unref();
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandledRejection');
});
