import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';

// We construct our own S3 client rather than reusing lib/s3.ts's because
// imports want a non-presigned, server-side put (the data is already in
// memory by the time we get here — there's no upload from the browser to
// presign). The keys live under `imports/` — note that no S3 lifecycle
// rule is configured by default; orphaned objects will accumulate unless
// the operator adds one (recommended: 90-day expiry on the `imports/`
// prefix per spec §10).
const client = new S3Client({
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

// Require all three of bucket, key, and secret. A half-configured `.env`
// (e.g. key without secret) used to slip past this check, then S3Client
// would fail opaquely on the first call. Treating the partial state as
// "unconfigured" keeps the dev fallback path intact and gives a clearer
// error at the boundary (where a missing secret usually is operator error).
export const s3ImportConfigured = (): boolean =>
  !!env.S3_BUCKET && !!env.AWS_ACCESS_KEY_ID && !!env.AWS_SECRET_ACCESS_KEY;

export function importKey(jobId: string): string {
  return `imports/${jobId}.csv`;
}

export async function putImportSource(
  jobId: string,
  body: Buffer,
  contentType = 'text/csv',
): Promise<string> {
  const key = importKey(jobId);
  if (!s3ImportConfigured()) {
    // Dev / test environments without S3 keep the import job machinery
    // working by holding the body in process memory keyed by the same
    // S3 key. The fallback is *not* shared across processes — multi-pod
    // staging will need real S3.
    devCache.set(key, body);
    return key;
  }
  await client.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
  return key;
}

export async function getImportSource(key: string): Promise<Buffer> {
  if (!s3ImportConfigured()) {
    const cached = devCache.get(key);
    if (!cached) throw new Error(`Import source not found in dev cache: ${key}`);
    return cached;
  }
  const out = await client.send(
    new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
  );
  if (!out.Body) throw new Error(`Empty body for ${key}`);
  // Node SDK v3 returns a Readable on Node, ReadableStream<Uint8Array> on
  // the edge runtime. We're always on Node; consume the stream.
  const stream = out.Body as Readable;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function deleteImportSource(key: string): Promise<void> {
  if (!s3ImportConfigured()) {
    devCache.delete(key);
    return;
  }
  // Best-effort delete — if it fails, the DB row's already gone (the
  // delete route deletes the row first), so we'd rather leave an orphan
  // than fail the API call. We *do* log the error so an operator can
  // notice the bucket bloating: an empty catch with no signal is the
  // antipattern this used to be.
  try {
    await client.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  } catch (err) {
    logger.warn(
      { err, key },
      'best-effort import source delete failed; orphan will stay until lifecycle reaps it',
    );
  }
}

// In-process fallback for dev/test where S3 isn't wired up. Keyed by the
// would-be S3 key so the rest of the importer doesn't need to know which
// backend served the bytes.
const devCache = new Map<string, Buffer>();
