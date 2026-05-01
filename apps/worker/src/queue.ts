import { Redis } from 'ioredis';
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
