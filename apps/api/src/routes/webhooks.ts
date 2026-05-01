import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  WEBHOOK_EVENTS,
  WEBHOOK_EVENT_GROUPS,
  WEBHOOK_TEST_EVENT,
  webhookEndpointCreateSchema,
  webhookEndpointUpdateSchema,
  type WebhookDeliveryDto,
  type WebhookDeliveryEventType,
  type WebhookEndpointDto,
} from '@pipelineflow/shared';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler, HttpError } from '../lib/error.js';
import {
  assertWebhookUrlAllowed,
  emitWebhookEvent,
  generateEventId,
  generateWebhookSecret,
} from '../lib/webhooks.js';
import { enqueueWebhookDelivery } from '../lib/queue.js';
import { rateLimit } from '../lib/rateLimit.js';

export const webhooksRouter = Router();
webhooksRouter.use(requireAuth);

// Even authenticated, an automated client could spam endpoint creates or
// fire test events to flood the queue. These match the existing
// jobs-router cadence (per-IP, 5-minute window).
const endpointWriteLimiter = rateLimit({
  max: 30,
  message: 'Too many webhook endpoint changes, slow down',
});
const testEventLimiter = rateLimit({
  max: 30,
  message: 'Too many test events, slow down',
});

// ─── Serialization ──────────────────────────────────────────────────────────

type WebhookEndpointRow = {
  id: number;
  name: string;
  url: string;
  secret: string;
  enabled: boolean;
  events: Prisma.JsonValue;
  customHeaders: Prisma.JsonValue;
  consecutiveFailures: number;
  disabledReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function endpointDto(
  e: WebhookEndpointRow,
  options: { includeSecret?: boolean } = {},
): WebhookEndpointDto {
  const events = Array.isArray(e.events) ? (e.events as unknown as WebhookEndpointDto['events']) : [];
  const customHeaders =
    e.customHeaders && typeof e.customHeaders === 'object' && !Array.isArray(e.customHeaders)
      ? (e.customHeaders as Record<string, string>)
      : null;
  const dto: WebhookEndpointDto = {
    id: e.id,
    name: e.name,
    url: e.url,
    events,
    customHeaders,
    enabled: e.enabled,
    consecutiveFailures: e.consecutiveFailures,
    disabledReason: e.disabledReason,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
  // Plaintext secret is *only* surfaced on create + rotate responses. The
  // user gets exactly one chance to copy it.
  if (options.includeSecret) dto.secret = e.secret;
  return dto;
}

function deliveryDto(d: {
  id: number;
  endpointId: number;
  eventId: string;
  eventType: string;
  status: string;
  responseStatus: number | null;
  responseBody: string | null;
  errorMessage: string | null;
  attemptCount: number;
  createdAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
}): WebhookDeliveryDto {
  return {
    id: d.id,
    endpointId: d.endpointId,
    eventId: d.eventId,
    eventType: d.eventType as WebhookDeliveryEventType,
    status: d.status as 'pending' | 'success' | 'failed',
    responseStatus: d.responseStatus,
    responseBody: d.responseBody,
    errorMessage: d.errorMessage,
    attemptCount: d.attemptCount,
    createdAt: d.createdAt.toISOString(),
    completedAt: d.completedAt?.toISOString() ?? null,
    durationMs: d.durationMs,
  };
}

// ─── Catalog ────────────────────────────────────────────────────────────────

webhooksRouter.get(
  '/events',
  asyncHandler(async (_req, res) => {
    res.json({ events: WEBHOOK_EVENTS, groups: WEBHOOK_EVENT_GROUPS });
  }),
);

// ─── Endpoint CRUD ──────────────────────────────────────────────────────────

webhooksRouter.get(
  '/endpoints',
  asyncHandler(async (_req, res) => {
    const endpoints = await prisma.webhookEndpoint.findMany({
      orderBy: { createdAt: 'desc' },
    });
    res.json({ endpoints: endpoints.map((e) => endpointDto(e)) });
  }),
);

webhooksRouter.post(
  '/endpoints',
  endpointWriteLimiter,
  asyncHandler(async (req, res) => {
    const input = webhookEndpointCreateSchema.parse(req.body);
    try {
      assertWebhookUrlAllowed(input.url, env.WEBHOOKS_ALLOW_PRIVATE_TARGETS);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : 'Invalid URL');
    }
    const created = await prisma.webhookEndpoint.create({
      data: {
        name: input.name,
        url: input.url,
        secret: generateWebhookSecret(),
        enabled: input.enabled ?? true,
        events: input.events as unknown as Prisma.InputJsonValue,
        customHeaders: (input.customHeaders ?? null) as Prisma.InputJsonValue,
      },
    });
    // Surface the generated secret exactly once — the UI banners it as
    // "store this now, you can't see it again".
    res.status(201).json({ endpoint: endpointDto(created, { includeSecret: true }) });
  }),
);

webhooksRouter.get(
  '/endpoints/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id } });
    if (!endpoint) throw new HttpError(404, 'Endpoint not found');
    res.json({ endpoint: endpointDto(endpoint) });
  }),
);

webhooksRouter.patch(
  '/endpoints/:id',
  endpointWriteLimiter,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const input = webhookEndpointUpdateSchema.parse(req.body);
    if (input.url !== undefined) {
      try {
        assertWebhookUrlAllowed(input.url, env.WEBHOOKS_ALLOW_PRIVATE_TARGETS);
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : 'Invalid URL');
      }
    }
    const data: Prisma.WebhookEndpointUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.url !== undefined) data.url = input.url;
    if (input.events !== undefined) data.events = input.events as unknown as Prisma.InputJsonValue;
    if (input.customHeaders !== undefined)
      data.customHeaders = (input.customHeaders ?? null) as Prisma.InputJsonValue;
    if (input.enabled !== undefined) {
      data.enabled = input.enabled;
      // User-driven re-enable clears the auto-disable reason and resets
      // the failure counter — they get a clean slate to retry.
      if (input.enabled === true) {
        data.disabledReason = null;
        data.consecutiveFailures = 0;
      }
    }
    const updated = await prisma.webhookEndpoint.update({ where: { id }, data });
    res.json({ endpoint: endpointDto(updated) });
  }),
);

webhooksRouter.delete(
  '/endpoints/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    // Cascade on the FK takes deliveries down with the endpoint — no
    // orphaned rows.
    await prisma.webhookEndpoint.delete({ where: { id } });
    res.json({ ok: true });
  }),
);

webhooksRouter.post(
  '/endpoints/:id/rotate-secret',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const updated = await prisma.webhookEndpoint.update({
      where: { id },
      data: { secret: generateWebhookSecret() },
    });
    res.json({ endpoint: endpointDto(updated, { includeSecret: true }) });
  }),
);

// Sends a synthetic `webhook.test` event to this specific endpoint —
// always with `type: "webhook.test"` so receivers can branch on the
// type and skip strict-schema validation for it. Bypasses the normal
// fan-out (which is event-subscription gated) so the user can verify
// connectivity even on an endpoint that subscribes to a single event.
webhooksRouter.post(
  '/endpoints/:id/test',
  testEventLimiter,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id } });
    if (!endpoint) throw new HttpError(404, 'Endpoint not found');
    if (!endpoint.enabled) throw new HttpError(409, 'Endpoint is disabled');

    const eventId = generateEventId();
    const envelope = {
      id: eventId,
      type: WEBHOOK_TEST_EVENT,
      createdAt: new Date().toISOString(),
      data: {
        test: true,
        endpointId: endpoint.id,
        message: 'This is a test event from PipelineFlow Settings → Webhooks.',
      },
    };
    const delivery = await prisma.webhookDelivery.create({
      data: {
        endpointId: endpoint.id,
        eventId,
        eventType: WEBHOOK_TEST_EVENT,
        payload: envelope as unknown as Prisma.InputJsonValue,
        status: 'pending',
      },
    });
    const job = await enqueueWebhookDelivery({ deliveryId: delivery.id });
    if (job.id) {
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { jobId: job.id },
      });
    }
    res.status(202).json({ deliveryId: delivery.id });
  }),
);

// ─── Deliveries ─────────────────────────────────────────────────────────────

const deliveriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.enum(['pending', 'success', 'failed']).optional(),
});

webhooksRouter.get(
  '/endpoints/:id/deliveries',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { limit, status } = deliveriesQuerySchema.parse(req.query);
    const deliveries = await prisma.webhookDelivery.findMany({
      where: { endpointId: id, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.json({ deliveries: deliveries.map(deliveryDto) });
  }),
);

webhooksRouter.get(
  '/deliveries/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const delivery = await prisma.webhookDelivery.findUnique({ where: { id } });
    if (!delivery) throw new HttpError(404, 'Delivery not found');
    // Include the full payload so the UI can show "what we tried to send"
    // — this endpoint is intentionally heavier than the list endpoint.
    res.json({
      delivery: deliveryDto(delivery),
      payload: delivery.payload,
    });
  }),
);

// Enqueues a fresh delivery of the same payload to the same endpoint.
// We create a new delivery row (preserving the original) so the audit
// trail of every attempt remains intact.
webhooksRouter.post(
  '/deliveries/:id/redeliver',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const original = await prisma.webhookDelivery.findUnique({ where: { id } });
    if (!original) throw new HttpError(404, 'Delivery not found');
    const endpoint = await prisma.webhookEndpoint.findUnique({
      where: { id: original.endpointId },
    });
    if (!endpoint) throw new HttpError(409, 'Endpoint no longer exists');
    if (!endpoint.enabled) throw new HttpError(409, 'Endpoint is disabled');

    const cloned = await prisma.webhookDelivery.create({
      data: {
        endpointId: original.endpointId,
        // Reuse the eventId so the receiver can dedupe if it already
        // accepted the original — redeliver should be idempotent on the
        // receiving side.
        eventId: original.eventId,
        eventType: original.eventType,
        payload: original.payload as unknown as Prisma.InputJsonValue,
        status: 'pending',
      },
    });
    const job = await enqueueWebhookDelivery({ deliveryId: cloned.id });
    if (job.id) {
      await prisma.webhookDelivery.update({
        where: { id: cloned.id },
        data: { jobId: job.id },
      });
    }
    res.status(202).json({ deliveryId: cloned.id });
  }),
);

// emitWebhookEvent is exported for tests and future internal triggers; the
// management routes themselves don't use it (the test endpoint targets a
// single endpoint, bypassing fan-out).
export { emitWebhookEvent };
