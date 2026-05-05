import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectCommand,
  type _Object,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Readable } from 'node:stream';
import { env } from '../env.js';

// Worker-local S3 client. Mirrors apps/api/src/lib/s3.ts — duplicated rather
// than extracted to packages/shared because shared is intentionally a
// zero-runtime-deps boundary (only zod). The same trade-off is already made
// by apps/worker/src/jobs/s3Reconcile.ts which constructs its own client.
export const s3 = new S3Client({
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

export const s3Configured = () => !!env.S3_BUCKET && !!env.AWS_ACCESS_KEY_ID;

/**
 * Stream-upload a file body to S3 via multipart. Aborts the partial upload
 * on error so a failed run can't leave dangling parts in the bucket (B2/R2
 * fall back to single PutObject below the part threshold; the abort is a
 * no-op in that case but cheap to call).
 */
export async function uploadStream(
  key: string,
  body: Readable,
  contentType: string,
  metadata?: Record<string, string>,
): Promise<void> {
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      Metadata: metadata,
    },
  });
  try {
    await upload.done();
  } catch (err) {
    try {
      await upload.abort();
    } catch {
      // upload.done() already aborts on error; abort() here is belt-and-braces
      // and may legitimately throw "no upload in progress" — ignore.
    }
    throw err;
  }
}

export async function listAllUnder(
  prefix: string,
  consume: (o: _Object) => void | Promise<void>,
): Promise<void> {
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: env.S3_BUCKET,
        Prefix: prefix,
        ContinuationToken: token,
        MaxKeys: 1000,
      }),
    );
    for (const obj of page.Contents ?? []) {
      await consume(obj);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
}

export async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
}
