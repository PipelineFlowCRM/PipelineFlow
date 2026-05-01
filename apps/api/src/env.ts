import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  APP_ORIGIN: z.string().url().default('http://localhost:5173'),
  S3_BUCKET: z.string().default(''),
  S3_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().default(''),
  AWS_SECRET_ACCESS_KEY: z.string().default(''),
  S3_ENDPOINT: z.string().default(''),
  // Optional: per-IP login attempts allowed inside RATE_LIMIT_WINDOW_MS.
  RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(5 * 60_000),
  // Set to 'false' to drop the `Secure` flag on the session cookie when
  // serving over plain HTTP (e.g. trusted-LAN homelab without TLS). Defaults
  // to true in production so the secure-by-default behaviour is unchanged.
  // Accepts any string so an empty value (compose default) parses cleanly.
  SESSION_COOKIE_SECURE: z
    .string()
    .optional()
    .transform((v) => (v === 'true' ? true : v === 'false' ? false : undefined)),
  // Toggle the in-process bull-board UI mounted at /admin/queues. Default
  // on; set to 'false' to disable in environments where exposing the queue
  // dashboard isn't appropriate.
  BULL_BOARD_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  // Toggle the smoke-test POST /api/jobs/generate + GET /api/jobs/generate/:id
  // endpoints. Default OFF — these have no production purpose. Flip to true
  // when you want to verify producer→broker→consumer end-to-end live.
  JOBS_TEST_ENDPOINT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

export const env = envSchema.parse(process.env);
export type Env = typeof env;
