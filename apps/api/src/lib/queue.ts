import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import {
  QUEUE_ENRICH_COMPANY,
  QUEUE_GENERATE,
  QUEUE_GOOGLE_CALENDAR_ARTIFACTS,
  QUEUE_GOOGLE_CALENDAR_PULL,
  QUEUE_GOOGLE_CONTACTS_PULL,
  QUEUE_GOOGLE_CONTACTS_PUSH,
  QUEUE_S3_CLEANUP,
  QUEUE_S3_RECONCILE,
  QUEUE_SCHEDULED_BACKUP,
  QUEUE_WEBHOOK_DELIVERY,
  type EnrichCompanyJobData,
  type EnrichCompanyJobResult,
  type GenerateJobData,
  type GenerateJobResult,
  type GoogleCalendarArtifactsJobData,
  type GoogleCalendarArtifactsJobResult,
  type GoogleCalendarPullJobData,
  type GoogleCalendarPullJobResult,
  type GoogleContactsPullJobData,
  type GoogleContactsPullJobResult,
  type GoogleContactsPushJobData,
  type GoogleContactsPushJobResult,
  type S3CleanupJobData,
  type S3CleanupJobResult,
  type S3ReconcileJobData,
  type S3ReconcileJobResult,
  type ScheduledBackupJobData,
  type ScheduledBackupJobResult,
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

// S3 deletes are individually idempotent (DeleteObject on a missing key is a
// 204), so the default 3-attempts-with-exponential-backoff is fine — no need
// for a custom strategy. Failures stick around in /admin/queues so an op can
// inspect the bucket if a region outage drops a batch.
export const s3CleanupQueue = new Queue<S3CleanupJobData, S3CleanupJobResult>(
  QUEUE_S3_CLEANUP,
  {
    connection: redisConnection,
    defaultJobOptions,
  },
);

// Reconcile uses a single `attempts` since it's idempotent and we'd rather
// the *next* run pick up any drift than retry a failing scan twice in a row.
const s3ReconcileJobOptions: JobsOptions = {
  attempts: 1,
  removeOnComplete: { age: 7 * 86_400, count: 30 },
  removeOnFail: { age: 7 * 86_400 },
};

export const s3ReconcileQueue = new Queue<S3ReconcileJobData, S3ReconcileJobResult>(
  QUEUE_S3_RECONCILE,
  {
    connection: redisConnection,
    defaultJobOptions: s3ReconcileJobOptions,
  },
);

// Scheduled backup. attempts: 2 — pg_dump is heavy, so loud-failing and
// letting the next cron tick pick up beats hammering the DB on retry. The
// processor's catch-up sweep ensures any local file an upload left behind
// gets pushed on the *next* successful run regardless.
const scheduledBackupJobOptions: JobsOptions = {
  attempts: 2,
  backoff: { type: 'exponential', delay: 60_000 },
  removeOnComplete: { age: 30 * 86_400, count: 90 },
  removeOnFail: { age: 30 * 86_400 },
};

export const scheduledBackupQueue = new Queue<
  ScheduledBackupJobData,
  ScheduledBackupJobResult
>(QUEUE_SCHEDULED_BACKUP, {
  connection: redisConnection,
  defaultJobOptions: scheduledBackupJobOptions,
});

// Google Contacts pull / push. Both share the default backoff because People
// API errors fall into two clean buckets: rate limits (we surface the
// server-suggested Retry-After via DelayedError on the worker side) and
// genuinely unexpected failures (re-try once or twice and let the next cron
// catch up). Retention defaults are slightly longer than the generic queues
// — sync regressions are easier to diagnose with a week of history in
// /admin/queues.
const googleContactsJobOptions: JobsOptions = {
  attempts: 4,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: { age: 86_400, count: 1_000 },
  removeOnFail: { age: 7 * 86_400 },
};

export const googleContactsPullQueue = new Queue<
  GoogleContactsPullJobData,
  GoogleContactsPullJobResult
>(QUEUE_GOOGLE_CONTACTS_PULL, {
  connection: redisConnection,
  defaultJobOptions: googleContactsJobOptions,
});

export const googleContactsPushQueue = new Queue<
  GoogleContactsPushJobData,
  GoogleContactsPushJobResult
>(QUEUE_GOOGLE_CONTACTS_PUSH, {
  connection: redisConnection,
  defaultJobOptions: googleContactsJobOptions,
});

// Calendar pull / artifact watcher. Same retry profile as contacts since
// the failure modes are the same family: rate-limited or transient 5xx.
// The artifact watcher retries are slightly more lenient because Gemini
// summary doc availability is genuinely flappy in the first ~30 minutes
// post-call — a 404 on the Drive search isn't a real failure, it's just
// "not yet."
const googleCalendarJobOptions: JobsOptions = {
  attempts: 4,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: { age: 86_400, count: 1_000 },
  removeOnFail: { age: 7 * 86_400 },
};

export const googleCalendarPullQueue = new Queue<
  GoogleCalendarPullJobData,
  GoogleCalendarPullJobResult
>(QUEUE_GOOGLE_CALENDAR_PULL, {
  connection: redisConnection,
  defaultJobOptions: googleCalendarJobOptions,
});

export const googleCalendarArtifactsQueue = new Queue<
  GoogleCalendarArtifactsJobData,
  GoogleCalendarArtifactsJobResult
>(QUEUE_GOOGLE_CALENDAR_ARTIFACTS, {
  connection: redisConnection,
  defaultJobOptions: googleCalendarJobOptions,
});

// Enrichment queue. Conservative concurrency on the worker side (2) — Anthropic
// rate limits matter here, and a CSV-import auto-enrich fan-out can otherwise
// burst hundreds of jobs into the queue at once. The cap-check inside the
// processor is the real backpressure (it skips over-cap runs without calling
// Anthropic), but tight worker concurrency keeps fewer concurrent calls in
// flight when we're below the cap. attempts: 2 — LLM calls failing once is
// usually a transient 5xx; failing twice is usually a real error worth
// surfacing rather than silently retrying a third time.
const enrichCompanyJobOptions: JobsOptions = {
  attempts: 2,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: { age: 7 * 86_400, count: 1_000 },
  removeOnFail: { age: 7 * 86_400 },
};

export const enrichCompanyQueue = new Queue<
  EnrichCompanyJobData,
  EnrichCompanyJobResult
>(QUEUE_ENRICH_COMPANY, {
  connection: redisConnection,
  defaultJobOptions: enrichCompanyJobOptions,
});

export const allQueues = [
  generateQueue,
  webhookDeliveryQueue,
  s3CleanupQueue,
  s3ReconcileQueue,
  scheduledBackupQueue,
  googleContactsPullQueue,
  googleContactsPushQueue,
  googleCalendarPullQueue,
  googleCalendarArtifactsQueue,
  enrichCompanyQueue,
];

export async function enqueueGenerate(data: GenerateJobData) {
  return generateQueue.add(QUEUE_GENERATE, data);
}

export async function enqueueWebhookDelivery(data: WebhookDeliveryJobData) {
  return webhookDeliveryQueue.add(QUEUE_WEBHOOK_DELIVERY, data);
}

export async function enqueueS3Cleanup(data: S3CleanupJobData) {
  if (data.keys.length === 0) return null;
  // Swallow + log Redis enqueue failures rather than letting the caller
  // 500. Every callsite runs *after* the user-visible mutation has
  // committed (delete deal, replace avatar, etc.), so a 500 here would
  // misrepresent the actual outcome and leave the user re-attempting a
  // delete that already succeeded. Reconcile is the safety net — orphans
  // get reaped on the next sweep.
  try {
    return await s3CleanupQueue.add(QUEUE_S3_CLEANUP, data);
  } catch (err) {
    logger.error(
      { err, count: data.keys.length },
      'failed to enqueue s3 cleanup; reconcile will reap',
    );
    return null;
  }
}

/**
 * Registers a daily repeatable reconcile job. BullMQ deduplicates repeatables
 * by name + repeat config, so calling this on every api boot is safe — it
 * either creates the schedule or no-ops. We pin a key so a future change in
 * cadence cleanly replaces the old schedule (otherwise the old one lingers).
 */
export async function ensureS3ReconcileScheduled() {
  // 03:17 UTC daily — a quiet hour offset by a few minutes so a fleet of
  // services scheduled at top-of-hour doesn't collide on Redis.
  await s3ReconcileQueue.add(
    QUEUE_S3_RECONCILE,
    {},
    {
      repeat: { pattern: '17 3 * * *' },
      jobId: 'recurring:s3-reconcile:daily',
    },
  );
}

export async function triggerS3ReconcileNow() {
  return s3ReconcileQueue.add(QUEUE_S3_RECONCILE, {});
}

// ─── Google Contacts producers ──────────────────────────────────────────────

export async function enqueueGoogleContactsPull(data: GoogleContactsPullJobData) {
  return googleContactsPullQueue.add(QUEUE_GOOGLE_CONTACTS_PULL, data, {
    // jobId pinning so a manual "Resync now" while a cron run is queued
    // collapses into one job per account. The worker enforces per-account
    // serial execution on top of this — see apps/worker/src/index.ts.
    jobId: `google-contacts-pull:${data.kind}:${data.googleAccountId}`,
  });
}

export async function enqueueGoogleContactsPush(data: GoogleContactsPushJobData) {
  // Push jobs aren't dedup-keyed: a contact edited twice in quick
  // succession should produce two jobs (the second wins on echo-hash
  // anyway, but a missed enqueue is worse than a redundant one). The
  // helper at integrations/google/enqueuePushIfConnected.ts is responsible
  // for skipping the enqueue when no account has outbound enabled.
  try {
    return await googleContactsPushQueue.add(QUEUE_GOOGLE_CONTACTS_PUSH, data);
  } catch (err) {
    logger.error({ err, data }, 'failed to enqueue google-contacts-push');
    return null;
  }
}

/**
 * Schedules the per-account incremental pull cron. Idempotent — calling
 * this for the same account on every api boot is a no-op once registered.
 * Safe to call when the user (re)connects an account.
 *
 * The interval is configurable via env so a homelab can dial it up to keep
 * Redis quiet, and a hosted deploy can dial it down for tighter sync.
 */
export async function ensureGoogleContactsPullScheduled(googleAccountId: number) {
  const intervalMs = env.GOOGLE_CONTACTS_SYNC_INTERVAL_MS;
  await googleContactsPullQueue.add(
    QUEUE_GOOGLE_CONTACTS_PULL,
    { kind: 'incremental', googleAccountId },
    {
      repeat: { every: intervalMs },
      jobId: `recurring:google-contacts-pull:${googleAccountId}`,
    },
  );
}

/**
 * Removes the recurring schedule for an account — call when the user
 * disconnects. BullMQ's repeatable-removal API has shifted across
 * versions and the (name, opts, jobId) overload silently no-ops on
 * minor mismatches. Listing + matching by jobId is the version-stable
 * path: once we have the repeatable's `key`, removeRepeatableByKey
 * always works.
 */
export async function unscheduleGoogleContactsPull(googleAccountId: number) {
  const wantedId = `recurring:google-contacts-pull:${googleAccountId}`;
  const repeatables = await googleContactsPullQueue.getRepeatableJobs();
  const target = repeatables.find((r) => r.id === wantedId);
  if (!target) {
    logger.warn(
      { googleAccountId, wantedId },
      'no matching repeatable to unschedule (already gone?)',
    );
    return;
  }
  await googleContactsPullQueue.removeRepeatableByKey(target.key);
}

// ─── Google Calendar producers ──────────────────────────────────────────────

export async function enqueueGoogleCalendarPull(data: GoogleCalendarPullJobData) {
  return googleCalendarPullQueue.add(QUEUE_GOOGLE_CALENDAR_PULL, data, {
    // jobId pinning so a manual "Resync" while a cron run is queued
    // collapses into one job per account. BullMQ's `addJob` validation
    // forbids `:` in custom ids — using `-` as the separator instead.
    jobId: `google-calendar-pull-${data.kind}-${data.googleAccountId}`,
  });
}

export async function enqueueGoogleCalendarArtifacts(data: GoogleCalendarArtifactsJobData) {
  // Bucket the jobId by minute so rapid double-clicks on the "refresh
  // artifacts" UI collapse into one job, but completed jobs in Redis's
  // retention window don't dedupe genuine subsequent refreshes (BullMQ
  // treats add() with an existing-jobId as a no-op even when that job
  // has finished). Same pattern as the scheduled-backup manual trigger.
  const minuteBucket = Math.floor(Date.now() / 60_000);
  return googleCalendarArtifactsQueue.add(QUEUE_GOOGLE_CALENDAR_ARTIFACTS, data, {
    jobId: `google-calendar-artifacts-${data.googleAccountId}-${minuteBucket}`,
  });
}

/**
 * Per-account incremental pull cron. Idempotent — calling on every api
 * boot is safe. Defaults to every 5 minutes per the spec; configurable
 * via env so a homelab can dial it back.
 */
export async function ensureGoogleCalendarPullScheduled(googleAccountId: number) {
  const intervalMs = env.GOOGLE_CALENDAR_SYNC_INTERVAL_MS;
  await googleCalendarPullQueue.add(
    QUEUE_GOOGLE_CALENDAR_PULL,
    { kind: 'incremental', googleAccountId },
    {
      repeat: { every: intervalMs },
      jobId: `recurring:google-calendar-pull:${googleAccountId}`,
    },
  );
  // Artifacts watcher runs on its own cadence — slower than the calendar
  // pull because Gemini summaries land 5–60 minutes post-call. Hitting
  // every 5 minutes here would burn API quota for no latency benefit.
  await googleCalendarArtifactsQueue.add(
    QUEUE_GOOGLE_CALENDAR_ARTIFACTS,
    { googleAccountId },
    {
      repeat: { every: env.GOOGLE_CALENDAR_ARTIFACTS_INTERVAL_MS },
      jobId: `recurring:google-calendar-artifacts:${googleAccountId}`,
    },
  );
}

export async function unscheduleGoogleCalendarPull(googleAccountId: number) {
  for (const queue of [googleCalendarPullQueue, googleCalendarArtifactsQueue]) {
    const wantedId =
      queue === googleCalendarPullQueue
        ? `recurring:google-calendar-pull:${googleAccountId}`
        : `recurring:google-calendar-artifacts:${googleAccountId}`;
    const repeatables = await queue.getRepeatableJobs();
    const target = repeatables.find((r) => r.id === wantedId);
    if (target) {
      await queue.removeRepeatableByKey(target.key);
    }
  }
}

/**
 * Force a *full* bucket scan on the next reconcile run. Encodes the intent
 * as a job-data flag rather than mutating shared Redis state: a forced run
 * queued while a daily run is in flight would previously be defeated by
 * the daily run writing its own high-water mark on completion. Returns the
 * enqueued job id so the caller can link to it in /admin/queues.
 */
export async function forceFullS3Reconcile(): Promise<string> {
  const job = await s3ReconcileQueue.add(QUEUE_S3_RECONCILE, { forceFull: true });
  return String(job.id);
}

// ─── Scheduled backup producers ─────────────────────────────────────────────

/**
 * Daily pg_dump → /backups → S3 push. Pinned jobId so multi-instance api
 * deployments converge on a single schedule and a redeploy doesn't strand
 * the previous repeatable. Default cron offsets from s3-reconcile so the
 * worker isn't woken by both cron jobs in the same minute. Operators can
 * override via BACKUP_SCHEDULE_CRON.
 */
export async function ensureScheduledBackupScheduled() {
  await scheduledBackupQueue.add(
    QUEUE_SCHEDULED_BACKUP,
    { trigger: 'cron' },
    {
      repeat: { pattern: env.BACKUP_SCHEDULE_CRON },
      jobId: 'recurring:scheduled-backup:daily',
    },
  );
}

/**
 * One-shot manual backup, used by the Maintenance card in settings. The
 * worker enforces a Redis lock so this safely no-ops when a cron run is
 * already in flight, but BullMQ would otherwise enqueue a fresh job per
 * click — leaving a trail of "completed: skipped" entries in /admin/queues.
 *
 * Bucket the jobId per minute: rapid double-clicks within the same minute
 * coalesce into a single job. Different enough from the cron's pinned id
 * that they don't conflict. Returns the job id for /admin/queues linking.
 */
export async function triggerScheduledBackupNow(): Promise<string> {
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const job = await scheduledBackupQueue.add(
    QUEUE_SCHEDULED_BACKUP,
    { trigger: 'manual' },
    { jobId: `manual:scheduled-backup:${minuteBucket}` },
  );
  return String(job.id);
}

// ─── Enrichment producer ────────────────────────────────────────────────────

/** Enqueue a company enrichment. The api should pre-create the EnrichmentRun
 *  row (status='pending') and pass the resulting `runId` so the worker can
 *  upsert into the same row — this lets the manual-flow polling endpoint
 *  resolve the run id immediately, before the worker has even started.
 *
 *  jobId pinning: at most one in-flight enrichment per company. A second
 *  trigger arriving while the first is queued collapses to a single job.
 *  Once the first completes, a follow-up enrich is allowed (the jobId is
 *  bucketed by minute to avoid pinning a long-lived completed job from
 *  blocking new ones). */
export async function enqueueEnrichCompany(data: EnrichCompanyJobData) {
  return enrichCompanyQueue.add(QUEUE_ENRICH_COMPANY, data, {
    jobId: `enrich-company:${data.companyId}:${data.runId}`,
  });
}

export async function closeQueues() {
  await Promise.allSettled(allQueues.map((q) => q.close()));
  await redisConnection.quit().catch(() => {
    // quit() rejects if already disconnected — harmless during shutdown.
  });
}
