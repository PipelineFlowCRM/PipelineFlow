import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(4001),
  // S3 — only required if the s3-cleanup job is enqueued. Empty defaults
  // mirror the api so a homelab without S3 still boots; the cleanup job
  // short-circuits when the bucket isn't configured.
  S3_BUCKET: z.string().default(''),
  S3_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().default(''),
  AWS_SECRET_ACCESS_KEY: z.string().default(''),
  S3_ENDPOINT: z.string().default(''),
});

export const env = envSchema.parse(process.env);
export type Env = typeof env;
