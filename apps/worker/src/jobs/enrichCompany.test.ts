// Tests for the enrichment job processor — guardrail short-circuits, error
// handling, manual-vs-auto status transitions. The merge-policy logic itself
// is covered by ../lib/enrichment/applyEnrichment.test.ts; this file
// exercises the layer above it.

import type { Job } from 'bullmq';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  EnrichCompanyJobData,
  EnrichCompanyJobResult,
} from '@pipelineflow/shared';

const prismaMocks = vi.hoisted(() => ({
  enrichmentRun: { update: vi.fn() },
  company: { findUnique: vi.fn(), update: vi.fn() },
  customFieldDefinition: { findUnique: vi.fn() },
  customFieldValue: { findUnique: vi.fn(), upsert: vi.fn() },
  note: { create: vi.fn() },
  $transaction: vi.fn(),
}));

const settingsMocks = vi.hoisted(() => ({
  readEnrichmentSettings: vi.fn(),
  getDailyUsage: vi.fn(),
  incrementDailyUsage: vi.fn(),
}));

const runMocks = vi.hoisted(() => ({
  runStructured: vi.fn(),
  runAgentic: vi.fn(),
}));

const envMocks = vi.hoisted(() => ({
  ANTHROPIC_API_KEY: 'sk-test',
  ANTHROPIC_MODEL: 'claude-test',
  ANTHROPIC_ENRICHMENT_MAX_TOKENS: 4096,
}));

vi.mock('../db.js', () => ({ prisma: prismaMocks }));
vi.mock('../queue.js', () => ({ redisConnection: {} }));
vi.mock('../env.js', () => ({ env: envMocks }));
vi.mock('../lib/enrichment/settings.js', () => settingsMocks);
vi.mock('../lib/enrichment/runStructured.js', () => ({
  runStructured: runMocks.runStructured,
}));
vi.mock('../lib/enrichment/runAgentic.js', () => ({
  runAgentic: runMocks.runAgentic,
}));

const { processEnrichCompany } = await import('./enrichCompany.js');

type FakeJob = Job<EnrichCompanyJobData, EnrichCompanyJobResult>;

function fakeJob(data: Partial<EnrichCompanyJobData> = {}): FakeJob {
  return {
    id: 'job-1',
    name: 'enrich-company',
    data: {
      companyId: 42,
      runId: 'run-1',
      trigger: 'auto-create',
      ...data,
    },
  } as unknown as FakeJob;
}

const baseSettings = {
  enabled: true,
  autoOnCreate: true,
  autoOnImport: false,
  mode: 'structured' as const,
  debounceDays: 30,
  dailyCap: 100,
};

const baseCompany = {
  id: 42,
  name: 'Acme Corp',
  industry: null,
  website: null,
  size: null,
  phone: null,
  addressLine1: null,
  addressLine2: null,
  city: null,
  state: null,
  postalCode: null,
  notes: null,
};

const successPayload = {
  industry: 'Software',
  size: '11-50 employees',
  summary: 'Acme makes things.',
  sources: [{ url: 'https://acme.example/about', fields: ['industry'] }],
};

beforeEach(() => {
  // resetAllMocks (not clearAllMocks) — clears any unconsumed
  // mockResolvedValueOnce queues from prior tests, then we re-establish
  // the defaults below. clearAllMocks only clears call history, not the
  // pending one-shot queue, which would let a queued resolution from a
  // manual-trigger test (which never consumes the debounce-row mock)
  // leak into the next test and trigger a false debounce skip.
  vi.resetAllMocks();
  envMocks.ANTHROPIC_API_KEY = 'sk-test';
  settingsMocks.readEnrichmentSettings.mockResolvedValue(baseSettings);
  settingsMocks.getDailyUsage.mockResolvedValue({ date: '2026-05-04', count: 0 });
  settingsMocks.incrementDailyUsage.mockResolvedValue(1);
  prismaMocks.enrichmentRun.update.mockResolvedValue({});
  prismaMocks.company.findUnique.mockResolvedValue(baseCompany);
  prismaMocks.customFieldDefinition.findUnique.mockResolvedValue({ id: 999 });
  prismaMocks.customFieldValue.findUnique.mockResolvedValue(null);
  prismaMocks.customFieldValue.upsert.mockResolvedValue({});
  prismaMocks.note.create.mockResolvedValue({});
  prismaMocks.company.update.mockResolvedValue({});
  prismaMocks.$transaction.mockImplementation(async (fn: any) => {
    if (typeof fn === 'function') {
      return fn(prismaMocks);
    }
    return Promise.all(fn);
  });
  runMocks.runStructured.mockResolvedValue({
    payload: successPayload,
    sourceUrl: 'https://acme.example',
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  });
  runMocks.runAgentic.mockResolvedValue({
    payload: successPayload,
    sourceUrl: null,
    inputTokens: 200,
    outputTokens: 60,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  });
});

describe('processEnrichCompany — guardrails', () => {
  it('skips with reason="disabled" when settings.enabled is false', async () => {
    settingsMocks.readEnrichmentSettings.mockResolvedValueOnce({
      ...baseSettings,
      enabled: false,
    });
    const result = await processEnrichCompany(fakeJob());
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('disabled');
    expect(runMocks.runStructured).not.toHaveBeenCalled();
    expect(runMocks.runAgentic).not.toHaveBeenCalled();
    expect(settingsMocks.incrementDailyUsage).not.toHaveBeenCalled();
  });

  it('skips with reason="not-configured" when ANTHROPIC_API_KEY is empty', async () => {
    envMocks.ANTHROPIC_API_KEY = '';
    const result = await processEnrichCompany(fakeJob());
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('not-configured');
    expect(runMocks.runStructured).not.toHaveBeenCalled();
  });

  it('skips with reason="daily-cap-reached" once usage hits the cap', async () => {
    settingsMocks.getDailyUsage.mockResolvedValueOnce({
      date: '2026-05-04',
      count: 100,
    });
    const result = await processEnrichCompany(fakeJob());
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('daily-cap-reached');
    expect(runMocks.runStructured).not.toHaveBeenCalled();
    expect(settingsMocks.incrementDailyUsage).not.toHaveBeenCalled();
  });

  it('skips with reason="company-deleted" when the company is gone', async () => {
    prismaMocks.company.findUnique.mockResolvedValueOnce(null);
    const result = await processEnrichCompany(fakeJob());
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('company-deleted');
    expect(runMocks.runStructured).not.toHaveBeenCalled();
  });

  it('skips with reason="debounce" when last_enriched_at is within window (auto trigger)', async () => {
    prismaMocks.customFieldValue.findUnique.mockResolvedValueOnce({
      valueDateTime: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), // 5 days ago
    });
    const result = await processEnrichCompany(fakeJob({ trigger: 'auto-create' }));
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('debounce');
    expect(runMocks.runStructured).not.toHaveBeenCalled();
  });

  it('does NOT debounce manual triggers — they always run', async () => {
    prismaMocks.customFieldValue.findUnique.mockResolvedValueOnce({
      valueDateTime: new Date(Date.now() - 1 * 60 * 1000), // 1 minute ago
    });
    const result = await processEnrichCompany(fakeJob({ trigger: 'manual' }));
    expect(result.status).toBe('proposed');
    expect(runMocks.runStructured).toHaveBeenCalledOnce();
  });

  it('does NOT debounce when the last_enriched_at field has never been bootstrapped', async () => {
    prismaMocks.customFieldDefinition.findUnique.mockResolvedValueOnce(null);
    const result = await processEnrichCompany(fakeJob({ trigger: 'auto-create' }));
    expect(result.status).toBe('applied');
  });
});

describe('processEnrichCompany — happy paths', () => {
  it('auto trigger → runs structured mode, applies fields, returns "applied"', async () => {
    const result = await processEnrichCompany(fakeJob({ trigger: 'auto-create' }));
    expect(result.status).toBe('applied');
    expect(runMocks.runStructured).toHaveBeenCalledOnce();
    expect(runMocks.runAgentic).not.toHaveBeenCalled();
    expect(prismaMocks.company.update).toHaveBeenCalled();
    expect(prismaMocks.note.create).toHaveBeenCalled();
    expect(settingsMocks.incrementDailyUsage).toHaveBeenCalledOnce();
  });

  it('manual trigger → runs LLM but stores payload as "proposed" without applying', async () => {
    const result = await processEnrichCompany(fakeJob({ trigger: 'manual' }));
    expect(result.status).toBe('proposed');
    expect(prismaMocks.company.update).not.toHaveBeenCalled();
    expect(prismaMocks.note.create).not.toHaveBeenCalled();
    // The LLM call still cost money — usage MUST tick up.
    expect(settingsMocks.incrementDailyUsage).toHaveBeenCalledOnce();
  });

  it('agentic mode → calls runAgentic instead of runStructured', async () => {
    settingsMocks.readEnrichmentSettings.mockResolvedValueOnce({
      ...baseSettings,
      mode: 'agentic',
    });
    await processEnrichCompany(fakeJob());
    expect(runMocks.runAgentic).toHaveBeenCalledOnce();
    expect(runMocks.runStructured).not.toHaveBeenCalled();
  });
});

describe('processEnrichCompany — error paths', () => {
  it('LLM error → marks run status="error" and re-throws for BullMQ retry', async () => {
    runMocks.runStructured.mockRejectedValueOnce(new Error('rate limit'));
    await expect(processEnrichCompany(fakeJob())).rejects.toThrow('rate limit');
    // The run row should be updated to status='error' before the throw.
    const errorUpdates = prismaMocks.enrichmentRun.update.mock.calls.filter(
      ([args]) => (args.data as any).status === 'error',
    );
    expect(errorUpdates).toHaveLength(1);
    // Errors don't count toward the daily cap — the API call may not have
    // actually billed (e.g. 429), and even if it did, double-charging the
    // user against their cap because of a transient failure is unfriendly.
    expect(settingsMocks.incrementDailyUsage).not.toHaveBeenCalled();
  });

  it('AnthropicNotConfiguredError thrown by the run → skipped, not errored', async () => {
    const { AnthropicNotConfiguredError } = await import(
      '../lib/enrichment/client.js'
    );
    runMocks.runStructured.mockRejectedValueOnce(new AnthropicNotConfiguredError());
    const result = await processEnrichCompany(fakeJob());
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('not-configured');
  });
});
