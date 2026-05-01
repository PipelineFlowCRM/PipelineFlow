import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Prisma } from '@prisma/client';
import type {
  WebhookEvent,
  WebhookEventEnvelope,
} from '@pipelineflow/shared';
import { prisma } from '../db.js';
import { logger } from './logger.js';
import { enqueueWebhookDelivery } from './queue.js';

// Endpoint is auto-disabled once it racks up this many consecutive
// terminal-failure deliveries (i.e. a delivery that's exhausted all 8
// retry attempts). Reset to 0 on every successful delivery.
export const AUTO_DISABLE_THRESHOLD = 5;

// Cap on the response-body slice we keep in the delivery log. Endpoints
// that respond with megabytes of HTML must not bloat the table.
export const RESPONSE_BODY_MAX_BYTES = 4_096;

// `whsec_<base64url-32>` matches the convention most webhook consumers
// expect (Stripe et al). 32 random bytes = 256 bits of entropy, well
// beyond the brute-force bound for HMAC-SHA256.
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

// `evt_<base64url-12>` — short enough to drop into log lines, long enough
// (~71 bits) that collisions don't matter for dedup keys.
export function generateEventId(): string {
  return `evt_${randomBytes(12).toString('base64url')}`;
}

// Stripe-style: signed string is `<unix>.<raw-body>`, header carries the
// timestamp and the v1 signature so consumers can verify replay windows.
export function buildSignatureHeader(secret: string, body: string, timestamp: number): string {
  const payload = `${timestamp}.${body}`;
  const v1 = createHmac('sha256', secret).update(payload).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

// Constant-time comparison helper exposed for tests / future inbound
// verification flows. Returns false instead of throwing on length mismatch.
export function verifySignature(
  secret: string,
  body: string,
  header: string,
  toleranceSeconds = 300,
): boolean {
  const parts: Record<string, string> = {};
  for (const kv of header.split(',')) {
    const [k, ...rest] = kv.split('=');
    if (!k) continue;
    parts[k.trim()] = rest.join('=').trim();
  }
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret)
    .update(`${t}.${body}`)
    .digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(v1, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Truncates the response body to the byte cap, then re-encodes safely so
// we never persist a half-multi-byte sequence.
export function truncateResponseBody(body: string): string {
  const buf = Buffer.from(body, 'utf8');
  if (buf.byteLength <= RESPONSE_BODY_MAX_BYTES) return body;
  // Slice on a UTF-8-safe boundary by converting the truncated buffer back
  // through TextDecoder which substitutes invalid trailing bytes.
  const slice = buf.subarray(0, RESPONSE_BODY_MAX_BYTES);
  return new TextDecoder('utf-8', { fatal: false }).decode(slice) + '…';
}

// Classifies an HTTP response status into retry vs. final. 5xx and the
// "please retry" 4xx codes (408 Timeout, 429 Too Many Requests) come back
// later; everything else stays where it landed.
export function shouldRetryStatus(status: number): boolean {
  if (status >= 500) return true;
  if (status === 408 || status === 429) return true;
  return false;
}

// Hostname-based SSRF guard. Returns true when the host literal would
// resolve into a private/internal range — used by the route layer to
// reject webhook URLs unless WEBHOOKS_ALLOW_PRIVATE_TARGETS is on.
//
// This deliberately checks the hostname *literal*, not the resolved IP.
// Resolving in advance would invite a DNS-rebinding race (resolve to a
// public IP at validation time, serve a private one at delivery time).
// A hostname-literal block stops the obvious cases (`localhost`,
// `192.168.x.x`, `host.docker.internal`, AWS metadata) without trying
// to defeat a determined attacker — that's what the env flag is for.
export function isPrivateHost(hostname: string): boolean {
  // Strip optional brackets for IPv6 literals.
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return true;

  // Special docker / dev / metadata-style names.
  if (
    host === 'localhost' ||
    host === 'host.docker.internal' ||
    host === 'gateway.docker.internal' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host.endsWith('.intranet') ||
    host.endsWith('.home.arpa')
  ) return true;

  const ipKind = isIP(host);
  if (ipKind === 0) {
    // Bare hostname (no dots, not an IP) — treat as internal. Catches
    // docker-compose service names like `postgres`, `redis`, `worker`.
    if (!host.includes('.')) return true;
    return false;
  }

  if (ipKind === 4) {
    const parts = host.split('.').map((n) => Number(n));
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    if (a === 0) return true;                       // 0.0.0.0/8
    if (a === 127) return true;                     // loopback
    if (a === 10) return true;                      // RFC 1918
    if (a === 192 && b === 168) return true;        // RFC 1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
    if (a === 169 && b === 254) return true;        // link-local + cloud metadata
    if (a >= 224) return true;                      // multicast / reserved
    return false;
  }

  // IPv6
  if (host === '::' || host === '::1') return true;
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — recurse on the v4 portion.
  const mapped = host.match(/^::ffff:([\d.]+)$/);
  if (mapped && mapped[1]) return isPrivateHost(mapped[1]);
  return false;
}

// Throws an HttpError-shaped object if the URL targets a private host
// and the env flag forbids it. Returns a parsed URL on success so the
// caller doesn't double-parse.
export function assertWebhookUrlAllowed(rawUrl: string, allowPrivate: boolean): URL {
  const url = new URL(rawUrl);
  if (!allowPrivate && isPrivateHost(url.hostname)) {
    const err = new Error(
      `URL targets a private/internal host (${url.hostname}). ` +
      'Set WEBHOOKS_ALLOW_PRIVATE_TARGETS=true on the api to allow.',
    ) as Error & { status: number };
    err.status = 400;
    throw err;
  }
  return url;
}

// ─── Emission ───────────────────────────────────────────────────────────────

type EmitInput = {
  eventType: WebhookEvent;
  // Snapshot the entity *outside* the caller's transaction (it must already
  // be committed). We don't include the snapshot inside the tx because a
  // failed enqueue shouldn't roll the entity write back.
  data: unknown;
};

// Used by route handlers right after their main DB work commits. Looks up
// every enabled endpoint subscribed to this event, writes one
// WebhookDelivery row per match, and enqueues a delivery job for each.
//
// Errors are swallowed (logged, not thrown) — webhook fanout is
// best-effort: a failure here must not 500 the user-facing request that
// already succeeded. If the queue is unreachable, the delivery row is
// still written in 'pending' state and a periodic recovery job (future)
// can re-enqueue.
export async function emitWebhookEvent({ eventType, data }: EmitInput): Promise<void> {
  try {
    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { enabled: true },
      select: { id: true, events: true },
    });
    const matching = endpoints.filter((e) => {
      const events = Array.isArray(e.events) ? (e.events as unknown as string[]) : [];
      return events.includes(eventType);
    });
    if (matching.length === 0) return;

    const eventId = generateEventId();
    const envelope: WebhookEventEnvelope = {
      id: eventId,
      type: eventType,
      createdAt: new Date().toISOString(),
      data,
    };

    // One delivery row per (event × endpoint). They share `eventId` so
    // consumers can correlate fanned-out copies.
    for (const ep of matching) {
      try {
        const delivery = await prisma.webhookDelivery.create({
          data: {
            endpointId: ep.id,
            eventId,
            eventType,
            payload: envelope as unknown as Prisma.InputJsonValue,
            status: 'pending',
          },
          select: { id: true },
        });
        const job = await enqueueWebhookDelivery({ deliveryId: delivery.id });
        if (job.id) {
          await prisma.webhookDelivery.update({
            where: { id: delivery.id },
            data: { jobId: job.id },
          });
        }
      } catch (err) {
        logger.error({ err, eventType, endpointId: ep.id }, 'failed to enqueue webhook delivery');
      }
    }
  } catch (err) {
    logger.error({ err, eventType }, 'webhook emission failed');
  }
}

// Convenience: fire-and-forget wrapper for routes that don't want to
// `await` (the per-request latency cost is tiny — a SELECT + N inserts —
// but a couple of hot paths still prefer to defer until after `res.json`).
export function emitWebhookEventDetached(input: EmitInput): void {
  void emitWebhookEvent(input);
}

// Snapshot-builder + emit in one call. Routes that need to read the
// post-mutation entity for the payload should use this so a snapshot
// failure (or a record that vanished between commit and read — e.g. a
// concurrent delete) never bubbles up and 500s the user-facing request.
export async function emitWithSnapshot(
  eventType: WebhookEvent,
  build: () => Promise<unknown | null>,
): Promise<void> {
  try {
    const data = await build();
    if (data == null) return;
    await emitWebhookEvent({ eventType, data });
  } catch (err) {
    logger.error({ err, eventType }, 'webhook snapshot/emit failed');
  }
}
