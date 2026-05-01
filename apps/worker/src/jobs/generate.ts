import type { Job } from 'bullmq';
import { nanoid } from 'nanoid';
import type { GenerateJobData, GenerateJobResult } from '@pipelineflow/shared';
import { logger } from '../logger.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function processGenerate(
  job: Job<GenerateJobData, GenerateJobResult>,
): Promise<GenerateJobResult> {
  const log = logger.child({ jobId: job.id, jobName: job.name });
  // Cap defensively even though the API schema already does — never trust
  // payloads on the worker side.
  const sleepMs = Math.min(Math.max(job.data.sleepMs ?? 3_000, 0), 30_000);

  log.info({ sleepMs, label: job.data.label }, 'processing generate job');

  await job.updateProgress(0);
  await sleep(sleepMs / 2);
  await job.updateProgress(50);
  await sleep(sleepMs / 2);
  await job.updateProgress(100);

  const result: GenerateJobResult = {
    generated: nanoid(),
    completedAt: new Date().toISOString(),
    ...(job.data.label ? { label: job.data.label } : {}),
  };

  log.info({ result }, 'completed generate job');
  return result;
}
