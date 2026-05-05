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
  // Google integrations — required only if a connected GoogleAccount row
  // exists; defaulting to empty mirrors the api so a worker can boot
  // without Google configured. Jobs targeting an unconfigured worker
  // surface a typed error instead of crashing.
  GOOGLE_OAUTH_CLIENT_ID: z.string().default(''),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().default(''),
  GOOGLE_TOKEN_ENCRYPTION_KEY: z.string().default(''),
  // Scheduled backup volume + retention. The api also uses BACKUP_DIR /
  // BACKUP_RETAIN_DAYS for its pre-migrate dumps; the values must match
  // (both containers mount the same pipelineflow-backups volume) so the
  // worker's catch-up sweep finds the api's files and the prune logic
  // doesn't fight itself.
  BACKUP_DIR: z.string().default('/backups'),
  BACKUP_RETAIN_DAYS: z.coerce.number().int().positive().default(30),
  // Anthropic API — same fail-soft pattern as the api. The enrichment job
  // refuses to run when ANTHROPIC_API_KEY is empty and the parent record
  // gets an EnrichmentRun row marked status='skipped' so the failure is
  // visible in the settings UI rather than as a silent worker error.
  ANTHROPIC_API_KEY: z.string().default(''),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-sonnet-4-6'),
  ANTHROPIC_ENRICHMENT_MAX_TOKENS: z.coerce.number().int().positive().default(4096),
  // Mirrors WEBHOOKS_ALLOW_PRIVATE_TARGETS on the api. When true (default)
  // the enrichment site fetcher will follow URLs into private/loopback/
  // metadata ranges — useful for homelab dev where Company.website might
  // be `http://host.docker.internal:3000`. Set to 'false' on public-facing
  // deploys to mitigate SSRF: anyone with workspace access could otherwise
  // set Company.website to e.g. `http://169.254.169.254/...` and have the
  // worker leak the response body into the LLM prompt.
  ENRICHMENT_ALLOW_PRIVATE_TARGETS: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
});

export const env = envSchema.parse(process.env);
export type Env = typeof env;
