import { Worker } from 'bullmq';
import {
  QUEUE_ENRICH_COMPANY,
  QUEUE_GENERATE,
  QUEUE_GOOGLE_CALENDAR_ARTIFACTS,
  QUEUE_GOOGLE_CALENDAR_PULL,
  QUEUE_GOOGLE_CONTACTS_PULL,
  QUEUE_GOOGLE_CONTACTS_PUSH,
  QUEUE_S3_CLEANUP,
  QUEUE_S3_RECONCILE,
  QUEUE_SCHEDULED_BACKUP,
  QUEUE_WEBHOOK_DELIVERY,
} from '@pipelineflow/shared';
import { env } from './env.js';
import { logger } from './logger.js';
import { redisConnection, s3CleanupProducer } from './queue.js';
import { prisma } from './db.js';
import { processEnrichCompany } from './jobs/enrichCompany.js';
import { processGenerate } from './jobs/generate.js';
import { processGoogleCalendarArtifacts } from './jobs/googleCalendarArtifacts.js';
import { processGoogleCalendarPull } from './jobs/googleCalendarPull.js';
import { processGoogleContactsPull } from './jobs/googleContactsPull.js';
import { processGoogleContactsPush } from './jobs/googleContactsPush.js';
import { processS3Cleanup } from './jobs/s3Cleanup.js';
import { makeReconcileProcessor } from './jobs/s3Reconcile.js';
import { makeScheduledBackupProcessor } from './jobs/scheduledBackup.js';
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

// Google Contacts pull / push. Both run with concurrency=2 globally —
// per-account serial ordering is enforced by the API enqueueing one
// pull job per account at a time (jobId-deduped) and the push processor
// being idempotent on echo-hash. People API's ~90 req/user/min ceiling
// is comfortably above what we can realistically generate from a single
// account at this concurrency.
const googleContactsPullWorker = new Worker(
  QUEUE_GOOGLE_CONTACTS_PULL,
  processGoogleContactsPull,
  { connection: redisConnection, concurrency: 2 },
);
googleContactsPullWorker.on('completed', (job, result) => {
  logger.debug(
    { jobId: job.id, applied: result?.applied, skipped: result?.skipped },
    'google contacts pull completed',
  );
});
googleContactsPullWorker.on('failed', (job, err) => {
  logger.warn(
    { jobId: job?.id, googleAccountId: job?.data?.googleAccountId, err: err.message },
    'google contacts pull failed',
  );
});
googleContactsPullWorker.on('error', (err) => {
  logger.error({ err }, 'google contacts pull worker error');
});

const googleContactsPushWorker = new Worker(
  QUEUE_GOOGLE_CONTACTS_PUSH,
  processGoogleContactsPush,
  { connection: redisConnection, concurrency: 2 },
);
googleContactsPushWorker.on('completed', (job, result) => {
  logger.debug({ jobId: job.id, outcome: result?.outcome }, 'google contacts push completed');
});
googleContactsPushWorker.on('failed', (job, err) => {
  logger.warn(
    { jobId: job?.id, kind: job?.data?.kind, err: err.message },
    'google contacts push failed',
  );
});
googleContactsPushWorker.on('error', (err) => {
  logger.error({ err }, 'google contacts push worker error');
});

// Calendar pull / artifacts. Same per-account-serial concurrency story
// as contacts: jobId pinning on the producer side keeps a single account
// from queueing parallel pulls; concurrency 2 globally lets two accounts
// run in parallel but caps fan-out under burst.
const googleCalendarPullWorker = new Worker(
  QUEUE_GOOGLE_CALENDAR_PULL,
  processGoogleCalendarPull,
  { connection: redisConnection, concurrency: 2 },
);
googleCalendarPullWorker.on('completed', (job, result) => {
  logger.debug(
    { jobId: job.id, upserted: result?.upserted, matched: result?.matched },
    'calendar pull completed',
  );
});
googleCalendarPullWorker.on('failed', (job, err) => {
  logger.warn(
    { jobId: job?.id, googleAccountId: job?.data?.googleAccountId, err: err.message },
    'calendar pull failed',
  );
});
googleCalendarPullWorker.on('error', (err) => {
  logger.error({ err }, 'calendar pull worker error');
});

const googleCalendarArtifactsWorker = new Worker(
  QUEUE_GOOGLE_CALENDAR_ARTIFACTS,
  processGoogleCalendarArtifacts,
  { connection: redisConnection, concurrency: 2 },
);
googleCalendarArtifactsWorker.on('completed', (job, result) => {
  logger.debug(
    { jobId: job.id, attached: result?.attached, partial: result?.partial },
    'calendar artifacts completed',
  );
});
googleCalendarArtifactsWorker.on('failed', (job, err) => {
  logger.warn(
    { jobId: job?.id, googleAccountId: job?.data?.googleAccountId, err: err.message },
    'calendar artifacts failed',
  );
});
googleCalendarArtifactsWorker.on('error', (err) => {
  logger.error({ err }, 'calendar artifacts worker error');
});

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

// Concurrency 1 — pg_dump is heavy and a second simultaneous dump would
// double the DB load for no gain. Job-level Redis lock is also enforced
// inside the processor, so a manual trigger fired alongside a cron tick
// safely no-ops rather than queueing a spurious second run.
const scheduledBackupWorker = new Worker(
  QUEUE_SCHEDULED_BACKUP,
  makeScheduledBackupProcessor(redisConnection),
  { connection: redisConnection, concurrency: 1 },
);
scheduledBackupWorker.on('completed', (job, result) => {
  logger.info(
    {
      jobId: job.id,
      uploaded: result?.uploaded,
      pruned: result?.pruned,
      bytes: result?.bytes,
      durationMs: result?.durationMs,
    },
    'scheduled backup completed',
  );
});
scheduledBackupWorker.on('failed', (job, err) => {
  logger.warn({ jobId: job?.id, err: err.message }, 'scheduled backup failed');
});
scheduledBackupWorker.on('error', (err) => {
  logger.error({ err }, 'scheduled backup worker error');
});

// Concurrency 2 — Anthropic rate limits dominate here. The processor's
// daily-cap check is the real backpressure; this just keeps the in-flight
// count modest under fan-out (e.g. CSV import auto-enriching 500 companies).
const enrichCompanyWorker = new Worker(
  QUEUE_ENRICH_COMPANY,
  processEnrichCompany,
  { connection: redisConnection, concurrency: 2 },
);
enrichCompanyWorker.on('completed', (job, result) => {
  logger.info(
    {
      jobId: job.id,
      companyId: job.data?.companyId,
      runId: result?.runId,
      status: result?.status,
      reason: result?.reason,
    },
    'enrich-company completed',
  );
});
enrichCompanyWorker.on('failed', (job, err) => {
  logger.warn(
    { jobId: job?.id, companyId: job?.data?.companyId, err: err.message },
    'enrich-company failed',
  );
});
enrichCompanyWorker.on('error', (err) => {
  logger.error({ err }, 'enrich-company worker error');
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
      scheduledBackupWorker.close(),
      googleContactsPullWorker.close(),
      googleContactsPushWorker.close(),
      googleCalendarPullWorker.close(),
      googleCalendarArtifactsWorker.close(),
      enrichCompanyWorker.close(),
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
