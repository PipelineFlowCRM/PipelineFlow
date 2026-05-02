import type { Job } from 'bullmq';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { S3CleanupJobData, S3CleanupJobResult } from '@pipelineflow/shared';
import { env } from '../env.js';
import { logger } from '../logger.js';

const s3 = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT || undefined,
  forcePathStyle: !!env.S3_ENDPOINT,
  credentials:
    env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        }
      : undefined,
});

const s3Configured = () => !!env.S3_BUCKET && !!env.AWS_ACCESS_KEY_ID;

export async function processS3Cleanup(
  job: Job<S3CleanupJobData, S3CleanupJobResult>,
): Promise<S3CleanupJobResult> {
  const log = logger.child({ jobId: job.id, jobName: job.name });
  const keys = job.data.keys ?? [];

  if (!s3Configured()) {
    log.warn({ count: keys.length }, 's3 not configured — skipping cleanup');
    return { deleted: 0 };
  }
  if (keys.length === 0) {
    return { deleted: 0 };
  }

  let deleted = 0;
  // One DeleteObject per key. We could batch via DeleteObjects (up to 1000
  // keys per call) but a typical deal has <10 attachments, and per-key
  // delete keeps the job retryable on partial failure without a custom
  // success-set tracker — BullMQ re-runs the whole job on retry, and the
  // surviving keys are no-ops the second time around (S3 returns 204 even
  // when the key doesn't exist).
  for (const key of keys) {
    await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    deleted += 1;
  }

  log.info({ requested: keys.length, deleted }, 's3 cleanup batch finished');
  return { deleted };
}
