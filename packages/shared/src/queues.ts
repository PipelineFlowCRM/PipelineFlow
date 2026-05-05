import { z } from 'zod';

export const QUEUE_GENERATE = 'generate' as const;

export const generateJobInputSchema = z.object({
  sleepMs: z.number().int().min(0).max(30_000).optional(),
  label: z.string().min(1).max(120).optional(),
});
export type GenerateJobInput = z.infer<typeof generateJobInputSchema>;

export type GenerateJobData = GenerateJobInput;
export type GenerateJobResult = {
  generated: string;
  completedAt: string;
  label?: string;
};

// ─── Webhook delivery queue ─────────────────────────────────────────────────
export const QUEUE_WEBHOOK_DELIVERY = 'webhook-delivery' as const;

// Job data is intentionally just the delivery row id — the worker re-reads
// the row + endpoint on each attempt so an endpoint URL/secret rotation
// mid-flight is honoured by in-flight retries.
export type WebhookDeliveryJobData = {
  deliveryId: number;
};
export type WebhookDeliveryJobResult = {
  status: 'success' | 'failed';
  responseStatus?: number;
};

// ─── S3 cleanup queue ───────────────────────────────────────────────────────
// Decouples bucket deletes from the user-facing request that orphans them.
// Used when a parent row (deal, task) cascade-deletes its attachments and we
// can't run application code inside the SQL cascade. The job itself is
// idempotent — re-deleting a missing key is a no-op.
export const QUEUE_S3_CLEANUP = 's3-cleanup' as const;

export type S3CleanupJobData = {
  keys: string[];
};
export type S3CleanupJobResult = {
  deleted: number;
};

// ─── Google Contacts sync queues ────────────────────────────────────────────
// Two queues, one per direction. Pull is scheduled (cron + on-connect
// one-shot); push is enqueued from the API on every contact mutation. Both
// jobs key by `googleAccountId` so per-account concurrency / rate-limits
// can be enforced without crowding out other accounts. Job data
// deliberately *doesn't* embed the contact body — the worker re-reads from
// Postgres on every retry so an in-flight job picks up the latest state if
// the user edited the same contact again before the queue caught up.
export const QUEUE_GOOGLE_CONTACTS_PULL = 'google-contacts-pull' as const;
export const QUEUE_GOOGLE_CONTACTS_PUSH = 'google-contacts-push' as const;

export type GoogleContactsPullJobData =
  // First-run bulk import. Paginates `people.connections.list`,
  // checkpointing initialPageToken after each page. Cleared & switches to
  // `incremental` once `nextSyncToken` is recorded.
  | { kind: 'initial'; googleAccountId: number }
  // Delta sync via the stored syncToken. Falls back to a full sync if
  // Google returns 410 Gone (token expired after ~7d disuse).
  | { kind: 'incremental'; googleAccountId: number };

export type GoogleContactsPullJobResult = {
  applied: number;
  skipped: number;
  // Set to true when initial import completed during this run; the cron
  // reads it to decide whether to switch over to incremental sync.
  initialDoneNow?: boolean;
};

export type GoogleContactsPushJobData =
  | { kind: 'upsert'; contactId: number; googleAccountId: number }
  // Delete is keyed by resourceName because the PF Contact row is gone by
  // the time the job runs (delete handler captures it before the row is
  // removed and enqueues this).
  | { kind: 'delete'; resourceName: string; googleAccountId: number };

export type GoogleContactsPushJobResult = {
  outcome: 'pushed' | 'skipped-echo' | 'skipped-disabled' | 'skipped-missing-link';
};

// ─── S3 reconcile queue ─────────────────────────────────────────────────────
// Daily sweep that catches keys the inline-cleanup paths miss: presigned
// PUTs that succeeded at S3 but never registered a row (client crashed
// mid-upload), and any other drift between bucket contents and the DB.
// The job itself just plans the work — it enqueues s3-cleanup batches for
// the orphans it finds. Scheduled as a BullMQ repeatable job by the api on
// boot so we don't need a separate cron container.
export const QUEUE_S3_RECONCILE = 's3-reconcile' as const;

export type S3ReconcileJobData = {
  // When true, the worker ignores the persisted "last reconciled at"
  // timestamp and rescans the entire bucket. Triggered from the
  // Maintenance settings page after a DB restore or when investigating
  // drift the incremental path can't catch on its own. Carried in job
  // data (rather than via a Redis sentinel) so a forced run started
  // mid-daily-run isn't clobbered when the daily run writes its own
  // high-water mark on completion.
  forceFull?: boolean;
};
export type S3ReconcileJobResult = {
  scanned: number;
  orphaned: number;
};

// ─── Scheduled backup queue ─────────────────────────────────────────────────
// Daily pg_dump → gzip → local /backups volume → S3 push. Catches up any
// pre-existing local files (e.g. pre-migrate dumps from the api container)
// on the same run, then prunes both local files and S3 objects older than
// BACKUP_RETAIN_DAYS. See docs/backups.md for the runbook.
export const QUEUE_SCHEDULED_BACKUP = 'scheduled-backup' as const;

export type ScheduledBackupJobData = {
  // 'cron' = produced by the daily repeatable. 'manual' = produced by the
  // /admin/scheduled-backup/run button. Only used for log labelling — the
  // processor's behaviour is identical either way.
  trigger: 'cron' | 'manual';
};

export type ScheduledBackupJobResult = {
  // Files newly uploaded to S3 this run, including the fresh dump and any
  // catch-up sweeps of orphaned local files.
  uploaded: number;
  // Total files removed from local + S3 by the retention prune.
  pruned: number;
  // Bytes written by the fresh pg_dump (not the catch-up uploads).
  bytes: number;
  durationMs: number;
};
