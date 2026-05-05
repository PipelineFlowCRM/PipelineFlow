import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../lib/error.js';
import { rateLimit } from '../lib/rateLimit.js';
import {
  forceFullS3Reconcile,
  redisConnection,
  triggerScheduledBackupNow,
} from '../lib/queue.js';

// Workspace-level operations that don't fit cleanly under a domain router
// (deals/contacts/etc.). Single-tenant means everyone signed-in is allowed
// here — if/when we grow per-user roles this is the obvious gate to swap
// in for admin-only middleware.
export const adminRouter = Router();
adminRouter.use(requireAuth);

// Cap the force-reconcile button at 5 hits per window. Each forced sweep
// can list the entire bucket — a logged-in user spamming the endpoint
// (or a stuck retry loop in some integration) shouldn't be able to peg
// the worker on bucket scans.
const reconcileLimiter = rateLimit({
  max: 5,
  message: 'Too many reconcile requests, try again in a few minutes',
});

adminRouter.post(
  '/s3-reconcile/force',
  reconcileLimiter,
  asyncHandler(async (_req, res) => {
    const jobId = await forceFullS3Reconcile();
    res.json({ ok: true, jobId });
  }),
);

// Same shape and ceiling as the reconcile button — pg_dump is heavier than
// a bucket list, so if anything we want to be even stricter about how often
// a logged-in user can trigger one. Cron coverage is still daily so 5 manual
// runs is plenty of headroom for the only realistic use (verify after a
// config change).
const backupLimiter = rateLimit({
  max: 5,
  message: 'Too many backup requests, try again in a few minutes',
});

// Mirrors the worker's LAST_SUCCESS_KEY constant — duplicated here to avoid
// pulling worker code into the api process. Update both if it ever changes.
const SCHEDULED_BACKUP_LAST_SUCCESS_KEY = 'pf:scheduled-backup:last-success';

adminRouter.post(
  '/scheduled-backup/run',
  backupLimiter,
  asyncHandler(async (_req, res) => {
    const jobId = await triggerScheduledBackupNow();
    res.json({ ok: true, jobId });
  }),
);

adminRouter.get(
  '/scheduled-backup',
  asyncHandler(async (_req, res) => {
    const raw = await redisConnection.get(SCHEDULED_BACKUP_LAST_SUCCESS_KEY);
    const ms = raw ? Number(raw) : null;
    const lastSuccessAt = ms && Number.isFinite(ms) && ms > 0
      ? new Date(ms).toISOString()
      : null;
    res.json({ lastSuccessAt });
  }),
);
