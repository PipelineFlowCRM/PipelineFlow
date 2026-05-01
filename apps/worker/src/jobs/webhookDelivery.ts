import { createHmac } from 'node:crypto';
import type { Job } from 'bullmq';
import type { Prisma } from '@prisma/client';
import type {
  WebhookDeliveryJobData,
  WebhookDeliveryJobResult,
} from '@pipelineflow/shared';
import { prisma } from '../db.js';
import { logger } from '../logger.js';

// Mirrors the lib/webhooks.ts thresholds in the api package; kept duplicated
// here so the worker doesn't take a runtime dependency on the api package.
const AUTO_DISABLE_THRESHOLD = 5;
const RESPONSE_BODY_MAX_BYTES = 4_096;
// Per-attempt fetch timeout. Generous enough that a slow consumer returns
// 200 in time, tight enough that one broken endpoint can't pin a worker
// slot. Combined with bullmq concurrency this caps the blast radius.
const REQUEST_TIMEOUT_MS = 30_000;

function buildSignatureHeader(secret: string, body: string, timestamp: number): string {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

function truncateResponseBody(body: string): string {
  const buf = Buffer.from(body, 'utf8');
  if (buf.byteLength <= RESPONSE_BODY_MAX_BYTES) return body;
  const slice = buf.subarray(0, RESPONSE_BODY_MAX_BYTES);
  return new TextDecoder('utf-8', { fatal: false }).decode(slice) + '…';
}

function shouldRetryStatus(status: number): boolean {
  if (status >= 500) return true;
  if (status === 408 || status === 429) return true;
  return false;
}

// Custom backoff schedule — referenced by name from the api-side queue
// config. attemptsMade is the count of failures so far (incremented BEFORE
// the strategy is called), so on the first call (after attempt 1 fails) we
// return the delay before attempt 2.
//
// Schedule: 30s, 1m, 5m, 15m, 30m, 1h, 2h.  attempts=8 means at most 7
// retries, so 7 entries cover the worst-case ladder.
const RETRY_DELAYS_MS = [
  30_000,           // attempt 2: 30s after attempt 1
  60_000,           // attempt 3: +1m
  5 * 60_000,       // attempt 4: +5m
  15 * 60_000,      // attempt 5: +15m
  30 * 60_000,      // attempt 6: +30m
  60 * 60_000,      // attempt 7: +1h
  2 * 60 * 60_000,  // attempt 8: +2h
];

export const webhookDeliveryBackoffStrategy = (attemptsMade: number): number => {
  const idx = Math.max(0, Math.min(attemptsMade - 1, RETRY_DELAYS_MS.length - 1));
  return RETRY_DELAYS_MS[idx]!;
};

// Bumps the endpoint's consecutiveFailures counter; auto-disables once the
// threshold is crossed. Wraps both writes in a transaction so a concurrent
// success-reset can't race in between (which would otherwise let us
// disable an endpoint that just recovered).
//
// Postgres row locks are held for the duration of the tx, so a parallel
// success update on the same row blocks until we commit. We re-read the
// post-increment state inside the tx and only disable if the counter is
// still ≥ threshold AND the endpoint is still enabled.
async function markEndpointFailure(endpointId: number): Promise<void> {
  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.webhookEndpoint.update({
      where: { id: endpointId },
      data: { consecutiveFailures: { increment: 1 } },
      select: { consecutiveFailures: true, enabled: true },
    });
    if (updated.consecutiveFailures >= AUTO_DISABLE_THRESHOLD && updated.enabled) {
      await tx.webhookEndpoint.update({
        where: { id: endpointId },
        data: {
          enabled: false,
          disabledReason: `Auto-disabled after ${updated.consecutiveFailures} consecutive delivery failures`,
        },
      });
      return { disabled: true, count: updated.consecutiveFailures };
    }
    return { disabled: false, count: updated.consecutiveFailures };
  });
  if (result.disabled) {
    logger.warn(
      { endpointId, consecutiveFailures: result.count },
      'auto-disabled webhook endpoint',
    );
  }
}

export async function processWebhookDelivery(
  job: Job<WebhookDeliveryJobData, WebhookDeliveryJobResult>,
): Promise<WebhookDeliveryJobResult> {
  const log = logger.child({ jobId: job.id, deliveryId: job.data.deliveryId });
  const { deliveryId } = job.data;

  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
  });
  if (!delivery) {
    // Row vanished (manual delete?) — nothing to do, don't retry.
    log.warn('delivery row missing — skipping');
    await job.discard();
    return { status: 'failed' };
  }
  if (delivery.status !== 'pending') {
    // Already terminally settled — likely a stalled job that re-ran after
    // a successful previous attempt. Idempotent skip.
    log.debug({ status: delivery.status }, 'delivery already terminal — skipping');
    return { status: delivery.status as 'success' | 'failed' };
  }

  const endpoint = await prisma.webhookEndpoint.findUnique({
    where: { id: delivery.endpointId },
  });
  if (!endpoint) {
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'failed',
        errorMessage: 'Endpoint deleted before delivery',
        completedAt: new Date(),
      },
    });
    await job.discard();
    throw new Error('endpoint deleted');
  }
  if (!endpoint.enabled) {
    // The user (or auto-disable) turned the endpoint off after the row was
    // queued. Mark the delivery skipped-as-failed and bail.
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'failed',
        errorMessage: endpoint.disabledReason ?? 'Endpoint disabled',
        completedAt: new Date(),
      },
    });
    await job.discard();
    throw new Error('endpoint disabled');
  }

  const startedAt = Date.now();
  let responseStatus: number | null = null;
  let responseBody: string | null = null;
  let errorMessage: string | null = null;
  let success = false;
  let retryable = false;

  try {
    const body = JSON.stringify(delivery.payload);
    const t = Math.floor(Date.now() / 1000);
    const signature = buildSignatureHeader(endpoint.secret, body, t);
    const headers: Record<string, string> = {
      // Reserved system headers — these always win over customHeaders.
      'Content-Type': 'application/json',
      'User-Agent': 'PipelineFlow-Webhooks/1.0',
      'X-PipelineFlow-Event': delivery.eventType,
      'X-PipelineFlow-Event-Id': delivery.eventId,
      'X-PipelineFlow-Delivery-Id': String(delivery.id),
      'X-PipelineFlow-Webhook-Id': String(endpoint.id),
      'X-PipelineFlow-Signature': signature,
    };
    const customHeaders = endpoint.customHeaders as Record<string, string> | null;
    if (customHeaders && typeof customHeaders === 'object') {
      for (const [k, v] of Object.entries(customHeaders)) {
        // Reserved headers can't be overridden — schema validation already
        // rejects them on save, but defend here too in case the row was
        // hand-edited.
        if (/^(content-type|user-agent|x-pipelineflow-)/i.test(k)) continue;
        headers[k] = v;
      }
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(endpoint.url, {
        method: 'POST',
        headers,
        body,
        signal: ctrl.signal,
        // Don't follow redirects — receivers shouldn't bounce signed
        // payloads to a different origin.
        redirect: 'manual',
      });
    } finally {
      clearTimeout(timer);
    }
    responseStatus = res.status;
    responseBody = truncateResponseBody(await res.text().catch(() => ''));
    if (res.status >= 200 && res.status < 300) {
      success = true;
    } else {
      retryable = shouldRetryStatus(res.status);
      errorMessage = `HTTP ${res.status}`;
    }
  } catch (err) {
    // fetch() throws on network error / abort. Always retryable — those are
    // exactly the transient cases retries exist for.
    retryable = true;
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  const durationMs = Date.now() - startedAt;

  // Persist this attempt's outcome regardless of success/failure. We always
  // bump attemptCount so the UI can show the retry ladder honestly.
  const attemptUpdate: Prisma.WebhookDeliveryUpdateInput = {
    attemptCount: { increment: 1 },
    responseStatus,
    responseBody,
    errorMessage,
    durationMs,
    ...(success ? { status: 'success', completedAt: new Date() } : {}),
  };
  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: attemptUpdate,
  });

  if (success) {
    // Reset the failure counter on any successful delivery — that's how
    // an endpoint recovers from a near-miss without manual intervention.
    // Scope the update to enabled rows only: if the endpoint was already
    // auto-disabled (e.g. by a parallel terminal failure), we don't want
    // a late-arriving success to silently wipe the disabledReason and
    // leave the user staring at a "Disabled" badge with no explanation.
    // Manual re-enable through PATCH is the supported recovery path.
    await prisma.webhookEndpoint.updateMany({
      where: { id: endpoint.id, enabled: true },
      data: { consecutiveFailures: 0, disabledReason: null },
    });
    return { status: 'success', responseStatus: responseStatus ?? undefined };
  }

  // Failure branch.
  const totalAttempts = job.opts.attempts ?? 1;
  const isFinalAttempt = job.attemptsMade + 1 >= totalAttempts;
  if (!retryable || isFinalAttempt) {
    // Mark the delivery terminally failed and credit the endpoint. We do
    // this here (rather than in the worker's `failed` listener) so the DB
    // state is consistent before the BullMQ event fires.
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { status: 'failed', completedAt: new Date() },
    });
    await markEndpointFailure(endpoint.id);
    if (!retryable) {
      // Tell BullMQ to stop retrying this job — the failure is permanent
      // (4xx, signature rejected, malformed URL, etc).
      await job.discard();
    }
  }

  throw new Error(errorMessage ?? 'webhook delivery failed');
}
