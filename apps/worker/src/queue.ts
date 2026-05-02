import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import {
  QUEUE_S3_CLEANUP,
  type S3CleanupJobData,
  type S3CleanupJobResult,
} from '@pipelineflow/shared';
import { env } from './env.js';
import { logger } from './logger.js';

// Separate ioredis instance from the api process — different runtime, own
// lifecycle. `maxRetriesPerRequest: null` is required by BullMQ for the
// Worker's blocking BRPOPLPUSH.
export const redisConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

redisConnection.on('error', (err: Error) => {
  logger.error({ err }, 'redis connection error');
});

// Producer handle for jobs that *originate inside the worker* — the daily
// reconcile sweep enqueues cleanup batches as it discovers orphans. The api
// owns the user-facing producers; this one's only job is to fan reconcile
// findings out to the cleanup queue without going through the api process.
export const s3CleanupProducer = new Queue<S3CleanupJobData, S3CleanupJobResult>(
  QUEUE_S3_CLEANUP,
  { connection: redisConnection },
);
