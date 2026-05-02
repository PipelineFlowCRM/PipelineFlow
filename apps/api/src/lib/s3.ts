import { randomUUID } from 'node:crypto';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../env.js';

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

export const s3Configured = () => !!env.S3_BUCKET && !!env.AWS_ACCESS_KEY_ID;

const sanitize = (name: string) =>
  name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-200) || 'file';

export function buildKey(scope: 'attachment' | 'avatar' | 'logo', filename: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return `${scope}/${date}/${randomUUID()}-${sanitize(filename)}`;
}

export async function presignPut(
  key: string,
  contentType: string,
  sizeBytes: number,
): Promise<string> {
  if (!s3Configured()) throw new Error('S3 is not configured');
  const cmd = new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
    ContentType: contentType,
    ContentLength: sizeBytes,
  });
  return getSignedUrl(client, cmd, { expiresIn: 60 * 5 });
}

/**
 * Build a `Content-Disposition: attachment` header value safely.
 * Per RFC 6266 / RFC 5987 we provide a sanitized ASCII filename for old
 * clients and the percent-encoded UTF-8 form for everyone else. CR/LF are
 * stripped so they can't terminate the header.
 */
export function dispositionHeader(downloadName: string): string {
  const cleaned = downloadName.replace(/[\r\n\\"]/g, '').trim() || 'download';
  const ascii = cleaned.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
  const utf8 = encodeURIComponent(cleaned);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

export async function presignGet(key: string, downloadName?: string): Promise<string> {
  if (!s3Configured()) throw new Error('S3 is not configured');
  const cmd = new GetObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
    ResponseContentDisposition: downloadName ? dispositionHeader(downloadName) : undefined,
  });
  return getSignedUrl(client, cmd, { expiresIn: 60 * 5 });
}

/** Inline (image) variant — no `attachment;` disposition. Used for avatars/logos. */
export async function presignInlineGet(key: string): Promise<string> {
  if (!s3Configured()) throw new Error('S3 is not configured');
  const cmd = new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key });
  return getSignedUrl(client, cmd, { expiresIn: 60 * 60 }); // 1 hour for image caching
}

export async function deleteObject(key: string): Promise<void> {
  if (!s3Configured()) return;
  await client.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
}

/**
 * Resolve a stored "image-ish" reference (avatar/logo) to something the
 * browser can fetch. Absolute URLs pass through; bare `avatar/...` /
 * `logo/...` keys get a presigned GET. Returns `null` for null inputs and
 * when S3 isn't configured (so the column degrades to "no image" rather
 * than 500-ing).
 */
export async function resolveImageRef(ref: string | null | undefined): Promise<string | null> {
  if (!ref) return null;
  if (/^https?:\/\//i.test(ref)) return ref;
  if (!s3Configured()) return null;
  return presignInlineGet(ref);
}

/**
 * Returns the S3 key that the cleanup queue should remove when a stored
 * `avatarUrl`/`logoUrl` ref is being replaced or cleared. Filters out:
 *   - unchanged refs (no replacement → nothing to clean)
 *   - absolute http(s) URLs (not in our bucket)
 *   - missing old refs
 * The single random-uuid-per-upload key scheme means refs are never shared
 * across entities, so a replacement is always safe to delete.
 */
export function obsoleteImageKey(
  oldRef: string | null,
  newRef: string | null | undefined,
): string | null {
  if (oldRef == null || oldRef === '') return null;
  if (oldRef === newRef) return null;
  if (/^https?:\/\//i.test(oldRef)) return null;
  return oldRef;
}
