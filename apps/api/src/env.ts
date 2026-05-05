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
  // Whether webhook endpoint URLs may target private/loopback/link-local
  // addresses. Defaults to TRUE so the homelab `host.docker.internal`
  // and LAN-IP setups work out of the box. Set to 'false' for
  // public-facing deploys to mitigate SSRF — anyone with auth can
  // otherwise turn the worker into a probe of the container's network.
  WEBHOOKS_ALLOW_PRIVATE_TARGETS: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  // Google integrations (Contacts, Gmail, Calendar). All four are required
  // together — the integration routes refuse to start the OAuth flow if
  // any are blank. The encryption key wraps the refresh token at rest
  // (AES-256-GCM, base64 of 32 raw bytes — generate with
  // `openssl rand -base64 32`).
  GOOGLE_OAUTH_CLIENT_ID: z.string().default(''),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().default(''),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().default(''),
  GOOGLE_TOKEN_ENCRYPTION_KEY: z.string().default(''),
  // 10 minutes by default — Google People API delta sync via syncToken is
  // cheap enough that this can be dialed down later if users want closer
  // to real-time. The token expires after ~7 days of disuse so we never
  // want this much higher than that.
  GOOGLE_CONTACTS_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(10 * 60_000),
  // Cron pattern for the scheduled-backup repeatable. Default 04:42 UTC daily,
  // offset from s3-reconcile (03:17 UTC) so the worker isn't woken by both
  // cron jobs in the same minute. The worker actually runs the dump; this
  // env lives on the api because the api owns producer registration.
  BACKUP_SCHEDULE_CRON: z.string().min(1).default('42 4 * * *'),
  // Anthropic API — powers the company-enrichment feature. When ANTHROPIC_API_KEY
  // is empty the enrichment routes return 503 and the settings page shows
  // "Anthropic isn't configured on this server." Same fail-soft pattern as the
  // Google integration. The model id is configurable so operators can dial
  // cost vs. quality (claude-haiku-4-5 → cheap; claude-opus-4-7 → top tier).
  ANTHROPIC_API_KEY: z.string().default(''),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-sonnet-4-6'),
  // Per-call output token cap — controls maximum response size (and worst-case
  // cost). 4096 is plenty for a structured enrichment payload + summary.
  ANTHROPIC_ENRICHMENT_MAX_TOKENS: z.coerce.number().int().positive().default(4096),
});

export const env = envSchema.parse(process.env);
export type Env = typeof env;
