import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import {
  QUEUE_GENERATE,
  QUEUE_WEBHOOK_DELIVERY,
  type GenerateJobData,
  type GenerateJobResult,
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

export const allQueues = [generateQueue, webhookDeliveryQueue];

export async function enqueueGenerate(data: GenerateJobData) {
  return generateQueue.add(QUEUE_GENERATE, data);
}

export async function enqueueWebhookDelivery(data: WebhookDeliveryJobData) {
  return webhookDeliveryQueue.add(QUEUE_WEBHOOK_DELIVERY, data);
}

export async function closeQueues() {
  await Promise.allSettled(allQueues.map((q) => q.close()));
  await redisConnection.quit().catch(() => {
    // quit() rejects if already disconnected — harmless during shutdown.
  });
}
