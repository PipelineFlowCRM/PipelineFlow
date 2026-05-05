import { buildApp } from './server.js';
import { env } from './env.js';
import { logger } from './lib/logger.js';
import { prisma } from './db.js';
import {
  closeQueues,
  ensureGoogleContactsPullScheduled,
  ensureS3ReconcileScheduled,
  ensureScheduledBackupScheduled,
} from './lib/queue.js';

const app = buildApp();
const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'PipelineFlow API listening');
});

// Register the daily orphan-bucket reconcile. BullMQ dedupes repeatables by
// jobId, so multi-instance api deployments converge on a single schedule
// without coordination. Failures here shouldn't block boot — the next boot
// will retry, and the queue still works without the recurring schedule.
void ensureS3ReconcileScheduled().catch((err) => {
  logger.error({ err }, 'failed to register s3-reconcile schedule');
});

// Register the daily pg_dump → S3 backup repeatable. Same idempotent
// pattern as reconcile above; the worker runs the actual dump.
void ensureScheduledBackupScheduled().catch((err) => {
  logger.error({ err }, 'failed to register scheduled-backup schedule');
});

// Re-register the per-account google contacts cron. BullMQ stores
// repeatables in Redis, so this is mostly idempotent — but a Redis FLUSH
// or a fresh stack would otherwise leave already-connected accounts
// without a schedule until the next manual reconnect. Doing it on boot
// keeps the system self-healing.
void (async () => {
  try {
    const accounts = await prisma.googleAccount.findMany({
      where: { disabledAt: null },
      select: { id: true },
    });
    for (const a of accounts) {
      await ensureGoogleContactsPullScheduled(a.id);
    }
  } catch (err) {
    logger.error({ err }, 'failed to register google contacts pull schedules');
  }
})();

let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  // Order: stop accepting requests → drain in-flight → close queue producer
  // and Redis → disconnect Prisma. Closing the BullMQ Queue after the HTTP
  // server quiesces means no handler is mid-enqueue when the connection
  // goes away.
  server.close(async (err) => {
    if (err) logger.error({ err }, 'error during server.close');
    try {
      await closeQueues();
    } catch (e) {
      logger.error({ err: e }, 'error closing queues');
    }
    try {
      await prisma.$disconnect();
    } catch (e) {
      logger.error({ err: e }, 'error disconnecting prisma');
    }
    process.exit(err ? 1 : 0);
  });
  // Bumped from 10s to 15s — Redis quit + queue close add latency on top
  // of HTTP drain.
  setTimeout(() => {
    logger.warn('forced exit after 15s grace');
    process.exit(1);
  }, 15_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandledRejection');
});
