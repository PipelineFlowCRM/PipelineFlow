import { z } from 'zod';

export const QUEUE_GENERATE = 'generate' as const;

export const generateJobInputSchema = z.object({
  sleepMs: z.number().int().min(0).max(30_000).optional(),
  label: z.string().min(1).max(120).optional(),
});
export type GenerateJobInput = z.infer<typeof generateJobInputSchema>;

export type GenerateJobData = GenerateJobInput;
export type GenerateJobResult = {
  generated: string;
  completedAt: string;
  label?: string;
};

// ─── Webhook delivery queue ─────────────────────────────────────────────────
export const QUEUE_WEBHOOK_DELIVERY = 'webhook-delivery' as const;

// Job data is intentionally just the delivery row id — the worker re-reads
// the row + endpoint on each attempt so an endpoint URL/secret rotation
// mid-flight is honoured by in-flight retries.
export type WebhookDeliveryJobData = {
  deliveryId: number;
};
export type WebhookDeliveryJobResult = {
  status: 'success' | 'failed';
  responseStatus?: number;
};
