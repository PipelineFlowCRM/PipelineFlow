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
