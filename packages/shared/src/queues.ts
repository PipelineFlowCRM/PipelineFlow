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

// ─── Google Calendar sync queues ────────────────────────────────────────────
// Two queues split along the same axis as the integration's two loops:
//   - calendar-pull: list events from Google Calendar, upsert Meeting rows,
//     run the auto-link matcher. Scheduled (every 5 minutes per account)
//     plus on-connect one-shot.
//   - calendar-artifacts: for completed meetings without all artifacts,
//     poll Meet recordings/transcripts and search Drive for the Gemini
//     summary doc. Runs on a slower cadence and gives up after the
//     6-hour cap defined in spec-artifact-attach.md.
// Job data deliberately keys on `googleAccountId` only — the worker
// re-queries Postgres on each run so an in-flight job picks up the
// freshest state (e.g. an event the rep just rescheduled).
export const QUEUE_GOOGLE_CALENDAR_PULL = 'google-calendar-pull' as const;
export const QUEUE_GOOGLE_CALENDAR_ARTIFACTS = 'google-calendar-artifacts' as const;

export type GoogleCalendarPullJobData =
  // Single mode for v1 — incremental delta with bounded re-list fallback.
  // Initial bulk-backfill is a P1 from the spec; we re-list a small
  // lookback window the first run instead of paginating the user's
  // entire calendar history.
  | { kind: 'incremental'; googleAccountId: number };

export type GoogleCalendarPullJobResult = {
  upserted: number;
  skipped: number;
  // The matcher ran on this many newly-ingested or changed meetings.
  matched: number;
};

export type GoogleCalendarArtifactsJobData = {
  // No mode here — the worker scans the full backlog of completed meetings
  // for this account and processes whatever's missing. Cheaper than
  // surgically queueing one job per meeting.
  googleAccountId: number;
};

export type GoogleCalendarArtifactsJobResult = {
  // Meetings the watcher touched on this run.
  considered: number;
  // Meetings where at least one artifact URL was newly populated.
  attached: number;
  // Meetings flagged partial (gave up after the 6h cap with at least one
  // artifact still missing).
  partial: number;
};

// ─── Enrichment queue ───────────────────────────────────────────────────────
// One job per company-enrichment attempt. The job re-reads the Company row
// each run so the latest record (post any in-flight edits) is what gets
// enriched. The runId pre-allocated by the api becomes the EnrichmentRun
// row's PK — the api hands it out so the manual flow can poll for the diff
// before it's fully written.
export const QUEUE_ENRICH_COMPANY = 'enrich-company' as const;

export type EnrichCompanyJobData = {
  companyId: number;
  // Set by the api when it pre-creates the run row. The worker upserts to
  // this id; absent → worker creates a new row (defensive — should never
  // fire in practice).
  runId: string;
  trigger: 'auto-create' | 'auto-import' | 'manual';
};

export type EnrichCompanyJobResult = {
  // 'applied'  → wrote fields + appended note (auto path)
  // 'proposed' → diff persisted, awaiting user confirmation (manual path)
  // 'skipped'  → guardrail short-circuited (cap, debounce, disabled, ambiguous)
  // 'error'    → see EnrichmentRun.errorMessage
  status: 'applied' | 'proposed' | 'skipped' | 'error';
  reason?: string;
  runId: string;
};

// ─── Geocode queue ──────────────────────────────────────────────────────────
// One job per address-to-coordinates resolution. The worker re-reads the
// Company row each run so the latest address (post any in-flight edits) is
// what gets geocoded. No per-run table — status lives on Company.geocoding*
// and BullMQ retains its own audit trail in /admin/queues.
export const QUEUE_GEOCODE_COMPANY = 'geocode-company' as const;

export type GeocodeCompanyJobData = {
  companyId: number;
  // 'manual' covers the v1 user-clicked button. Future expansion may add
  // 'auto-create' / 'auto-import' / 'backfill'.
  trigger: 'manual';
};

export type GeocodeCompanyJobResult = {
  // 'geocoded'  → wrote latitude/longitude/geocodedAt
  // 'not-found' → Mapbox returned zero features (permanent fail)
  // 'skipped'   → guardrail short-circuited (token missing, address became incomplete)
  // 'error'     → upstream failure surfaced after retries
  status: 'geocoded' | 'not-found' | 'skipped' | 'error';
  reason?: string;
};
