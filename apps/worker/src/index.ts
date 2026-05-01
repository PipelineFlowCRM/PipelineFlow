import { Worker } from 'bullmq';
import { QUEUE_GENERATE } from '@pipelineflow/shared';
import { env } from './env.js';
import { logger } from './logger.js';
import { redisConnection } from './queue.js';
import { prisma } from './db.js';
import { processGenerate } from './jobs/generate.js';
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
    await generateWorker.close();
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
