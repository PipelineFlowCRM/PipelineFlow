import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../lib/error.js';
import { rateLimit } from '../lib/rateLimit.js';
import { forceFullS3Reconcile } from '../lib/queue.js';

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
