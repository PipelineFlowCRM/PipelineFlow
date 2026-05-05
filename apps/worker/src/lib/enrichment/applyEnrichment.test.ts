// Unit tests for the enrichment merge layer. Focused on the policy logic —
// what gets written, what gets diffed — without exercising Prisma or the
// LLM call. The tx argument is a minimal mock that records writes so we can
// assert against them.

import { describe, it, expect, vi } from 'vitest';
import type { EnrichmentPayload } from '@pipelineflow/shared';
import { applyAuto, buildDiff } from './applyEnrichment.js';

type Captured = {
  companyUpdates: Array<{ id: number; data: Record<string, unknown> }>;
  notes: Array<Record<string, unknown>>;
  cfvUpserts: Array<{ where: unknown; create: unknown; update: unknown }>;
};

function fakeTx(captured: Captured): any {
  return {
    company: {
      update: vi.fn(async (args: any) => {
        captured.companyUpdates.push({ id: args.where.id, data: args.data });
        return {};
      }),
    },
    note: {
      create: vi.fn(async (args: any) => {
        captured.notes.push(args.data);
        return {};
      }),
    },
    customFieldDefinition: {
      findUnique: vi.fn(async () => ({ id: 999 })),
      create: vi.fn(async () => ({ id: 999 })),
    },
    customFieldValue: {
      upsert: vi.fn(async (args: any) => {
        captured.cfvUpserts.push(args);
        return {};
      }),
    },
  };
}

const baseCompany = {
  id: 42,
  name: 'Acme Corp',
  industry: null,
  website: 'https://acme.example',
  size: null,
  phone: null,
  addressLine1: null,
  addressLine2: null,
  city: null,
  state: null,
  postalCode: null,
};

const fullPayload: EnrichmentPayload = {
  industry: 'Software',
  size: '11-50 employees',
  website: 'https://acme.example',
  phone: '+1 555 0100',
  addressLine1: '1 Acme Way',
  city: 'San Francisco',
  state: 'CA',
  postalCode: '94110',
  summary: 'Acme makes things.',
  sources: [{ url: 'https://acme.example/about', fields: ['industry', 'size'] }],
};

describe('applyAuto (empty-fill)', () => {
  it('writes only fields that are currently null/empty', async () => {
    const captured: Captured = { companyUpdates: [], notes: [], cfvUpserts: [] };
    const tx = fakeTx(captured);
    await applyAuto(tx, {
      runId: 'r1',
      companyId: 42,
      payload: fullPayload,
      mode: 'auto',
      company: baseCompany,
    });
    // website was already set on the company; auto-mode must NOT overwrite.
    expect(captured.companyUpdates).toHaveLength(1);
    const data = captured.companyUpdates[0]!.data;
    expect(data.industry).toBe('Software');
    expect(data.size).toBe('11-50 employees');
    expect(data.phone).toBe('+1 555 0100');
    expect(data.city).toBe('San Francisco');
    expect(data.website).toBeUndefined(); // skipped — already set
  });

  it('appends a summary note when payload has one', async () => {
    const captured: Captured = { companyUpdates: [], notes: [], cfvUpserts: [] };
    const tx = fakeTx(captured);
    await applyAuto(tx, {
      runId: 'r1',
      companyId: 42,
      payload: fullPayload,
      mode: 'auto',
      company: baseCompany,
    });
    expect(captured.notes).toHaveLength(1);
    const note = captured.notes[0]!;
    expect(note.companyId).toBe(42);
    expect(String(note.content)).toContain('Acme makes things.');
    expect(String(note.content)).toContain('Sources');
  });

  it('stamps last_enriched_at via the bootstrapped DATETIME field', async () => {
    const captured: Captured = { companyUpdates: [], notes: [], cfvUpserts: [] };
    const tx = fakeTx(captured);
    await applyAuto(tx, {
      runId: 'r1',
      companyId: 42,
      payload: fullPayload,
      mode: 'auto',
      company: baseCompany,
    });
    expect(captured.cfvUpserts).toHaveLength(1);
    const u = captured.cfvUpserts[0]!;
    expect((u.create as any).valueDateTime).toBeInstanceOf(Date);
  });

  it('skips writes (status="skipped", reason="ambiguous") when payload.ambiguous is true', async () => {
    const captured: Captured = { companyUpdates: [], notes: [], cfvUpserts: [] };
    const tx = fakeTx(captured);
    const result = await applyAuto(tx, {
      runId: 'r1',
      companyId: 42,
      payload: { ...fullPayload, ambiguous: true, candidates: [{ name: 'Acme A' }, { name: 'Acme B' }] },
      mode: 'auto',
      company: baseCompany,
    });
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('ambiguous');
    expect(captured.companyUpdates).toHaveLength(0);
    // We still append a summary note explaining the ambiguity.
    expect(captured.notes).toHaveLength(1);
    expect(String(captured.notes[0]!.content)).toContain('Candidates');
  });
});

describe('buildDiff', () => {
  it('returns proposed-vs-current for each writable field', () => {
    const diff = buildDiff({
      runId: 'r1',
      companyId: 42,
      payload: fullPayload,
      mode: 'manual',
      company: baseCompany,
    });
    const keys = diff.fields.map((f) => f.key);
    expect(keys).toContain('industry');
    expect(keys).toContain('size');
    expect(keys).toContain('city');
    // website matches the existing value → omitted
    expect(keys).not.toContain('website');
  });

  it('flags selectedByDefault=true on empty current values', () => {
    const diff = buildDiff({
      runId: 'r1',
      companyId: 42,
      payload: fullPayload,
      mode: 'manual',
      company: baseCompany,
    });
    for (const f of diff.fields) {
      // None of baseCompany's fields except website are populated, so
      // every proposed field should default to selected.
      expect(f.selectedByDefault).toBe(true);
    }
  });

  it('selectedByDefault=false when current is set and differs from proposed', () => {
    const diff = buildDiff({
      runId: 'r1',
      companyId: 42,
      payload: fullPayload,
      mode: 'manual',
      company: { ...baseCompany, industry: 'Manual entry' },
    });
    const industry = diff.fields.find((f) => f.key === 'industry');
    expect(industry).toBeDefined();
    expect(industry!.selectedByDefault).toBe(false);
  });
});

// applySelected used to live in this file; its job (writing user-selected
// fields from a 'proposed' run) now lives inline in the api's
// /enrichment/runs/:id/apply route, which uses the shared
// ENRICHMENT_WRITABLE_FIELDS + formatEnrichmentNote helpers. The api route
// is covered by enrichment.test.ts at the surface level.
