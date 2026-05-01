import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import {
  QUEUE_GENERATE,
  type GenerateJobData,
  type GenerateJobResult,
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

export const allQueues = [generateQueue];

export async function enqueueGenerate(data: GenerateJobData) {
  return generateQueue.add(QUEUE_GENERATE, data);
}

export async function closeQueues() {
  await Promise.allSettled(allQueues.map((q) => q.close()));
  await redisConnection.quit().catch(() => {
    // quit() rejects if already disconnected — harmless during shutdown.
  });
}
