import { api } from './api';

interface PresignResponse {
  key: string;
  url: string;
  expiresIn: number;
}

export interface UploadOptions {
  /**
   * Per-byte progress callback. Fires as the browser reports XHR upload
   * progress events — typically several times per second for large files,
   * once for tiny ones. Not called after completion (read the resolved
   * promise instead).
   */
  onProgress?: (loaded: number, total: number) => void;
  /** AbortSignal to cancel an in-flight upload. */
  signal?: AbortSignal;
}

/**
 * Two-phase upload: (1) ask the api for a presigned PUT, (2) push the bytes
 * to S3 directly. For attachment scope we also (3) register the
 * corresponding DB row. Avatars/logos skip step 3 — the caller passes the
 * returned key to the entity's PATCH instead.
 *
 * Uses XMLHttpRequest for the PUT so callers can render progress bars; the
 * presign + register calls are still plain `fetch` since they're trivially
 * fast and respond with JSON.
 */
export async function uploadToS3(
  file: File,
  scope: 'attachment' | 'avatar' | 'logo',
  link: { dealId?: number; taskId?: number; companyId?: number; userId?: number } = {},
  opts: UploadOptions = {},
): Promise<{ key: string }> {
  const presign = await api.post<PresignResponse>('/uploads/presign', {
    filename: file.name,
    contentType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
    scope,
    dealId: link.dealId ?? null,
    taskId: link.taskId ?? null,
    companyId: link.companyId ?? null,
  });

  await putWithProgress(presign.url, file, opts);

  if (scope === 'attachment') {
    await api.post('/uploads/attachments', {
      key: presign.key,
      filename: file.name,
      contentType: file.type,
      sizeBytes: file.size,
      dealId: link.dealId ?? null,
      taskId: link.taskId ?? null,
    });
  }
  return { key: presign.key };
}

/**
 * XHR-based S3 PUT. fetch() works but doesn't expose upload progress events
 * (browsers haven't shipped Streams-based progress reporting), and a
 * progress bar is the whole point of this rewrite — so we drop to the
 * older API. Resolves on 2xx, rejects on anything else or on `abort`.
 */
function putWithProgress(url: string, file: File, opts: UploadOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    xhr.setRequestHeader(
      'Content-Type',
      file.type || 'application/octet-stream',
    );

    // Detach the abort listener once the XHR settles so a reused signal
    // doesn't keep firing into a long-dead xhr (also avoids holding a
    // reference to the xhr after completion).
    const onAbort = () => xhr.abort();
    const cleanup = () => {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    };

    if (opts.onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) opts.onProgress!(e.loaded, e.total);
      };
    }
    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`S3 upload failed: ${xhr.status}`));
    };
    xhr.onerror = () => {
      cleanup();
      reject(new Error('S3 upload failed: network error'));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException('Upload aborted', 'AbortError'));
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        xhr.abort();
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    xhr.send(file);
  });
}
