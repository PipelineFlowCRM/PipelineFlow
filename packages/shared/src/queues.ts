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
