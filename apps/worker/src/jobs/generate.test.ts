import type { Job } from 'bullmq';
import { describe, it, expect, vi } from 'vitest';
import type { GenerateJobData, GenerateJobResult } from '@pipelineflow/shared';
import { processGenerate } from './generate.js';

type FakeJob = Job<GenerateJobData, GenerateJobResult>;

const fakeJob = (data: GenerateJobData = {}): { job: FakeJob; updateProgress: ReturnType<typeof vi.fn> } => {
  const updateProgress = vi.fn().mockResolvedValue(undefined);
  const job = {
    id: 'job-1',
    name: 'generate',
    data,
    updateProgress,
  } as unknown as FakeJob;
  return { job, updateProgress };
};

describe('processGenerate', () => {
  it('returns a result with a generated id and ISO completedAt', async () => {
    const { job } = fakeJob({ sleepMs: 0 });
    const result = await processGenerate(job);
    expect(result.generated).toMatch(/^[A-Za-z0-9_-]{10,}$/); // nanoid alphabet
    expect(() => new Date(result.completedAt).toISOString()).not.toThrow();
    expect(new Date(result.completedAt).toISOString()).toBe(result.completedAt);
  });

  it('reports progress 0 → 50 → 100', async () => {
    const { job, updateProgress } = fakeJob({ sleepMs: 0 });
    await processGenerate(job);
    expect(updateProgress).toHaveBeenNthCalledWith(1, 0);
    expect(updateProgress).toHaveBeenNthCalledWith(2, 50);
    expect(updateProgress).toHaveBeenNthCalledWith(3, 100);
  });

  it('passes label through when provided', async () => {
    const { job } = fakeJob({ sleepMs: 0, label: 'smoke-test' });
    const result = await processGenerate(job);
    expect(result.label).toBe('smoke-test');
  });

  it('omits label key when not provided (does not return label: undefined)', async () => {
    const { job } = fakeJob({ sleepMs: 0 });
    const result = await processGenerate(job);
    expect('label' in result).toBe(false);
  });

  it('clamps sleepMs above 30s — does not actually sleep that long in test', async () => {
    // We assert the clamp by checking the wall-clock time is bounded by
    // 30s, not the absurd input. Test runs with sleepMs=0 to avoid actually
    // burning the budget; the clamp logic itself is verified by the next test.
    const { job } = fakeJob({ sleepMs: 999_999 });
    vi.useFakeTimers();
    const promise = processGenerate(job);
    // 30000ms total — split into two halves of 15000ms each.
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await promise;
    vi.useRealTimers();
    expect(result.generated).toBeTruthy();
  });

  it('treats negative sleepMs as 0', async () => {
    const { job, updateProgress } = fakeJob({ sleepMs: -100 });
    const result = await processGenerate(job);
    expect(updateProgress).toHaveBeenCalledTimes(3);
    expect(result.generated).toBeTruthy();
  });
});
