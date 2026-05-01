import { Router } from 'express';
import { generateJobInputSchema } from '@pipelineflow/shared';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler, HttpError } from '../lib/error.js';
import { rateLimit } from '../lib/rateLimit.js';
import { enqueueGenerate, generateQueue } from '../lib/queue.js';

export const jobsRouter = Router();

// Per-IP throttle on the smoke-test endpoint — even though it's auth-gated,
// an authenticated client can still flood the queue with 30s-long jobs.
const generateLimiter = rateLimit({
  max: 30,
  message: 'Too many generate requests, slow down',
});

jobsRouter.post(
  '/generate',
  requireAuth,
  generateLimiter,
  asyncHandler(async (req, res) => {
    const input = generateJobInputSchema.parse(req.body ?? {});
    const job = await enqueueGenerate(input);
    res.status(202).json({ jobId: job.id });
  }),
);

jobsRouter.get(
  '/generate/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id ?? '');
    if (!id) throw new HttpError(400, 'Missing job id');
    const job = await generateQueue.getJob(id);
    if (!job) throw new HttpError(404, 'Job not found');
    const state = await job.getState();
    res.json({
      id: job.id,
      state,
      progress: job.progress,
      returnvalue: job.returnvalue,
      failedReason: job.failedReason,
      attemptsMade: job.attemptsMade,
    });
  }),
);
