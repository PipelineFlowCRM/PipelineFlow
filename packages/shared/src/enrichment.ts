import { z } from 'zod';

// ─── Settings (workspace-wide) ──────────────────────────────────────────────
// Backed by the existing `Setting` key/value table. Keys are namespaced under
// `enrichment:` so they're easy to grep for and don't collide with future
// settings categories.

export const ENRICHMENT_SETTING_KEYS = {
  enabled: 'enrichment:enabled',
  autoOnCreate: 'enrichment:auto_on_create',
  autoOnImport: 'enrichment:auto_on_import',
  mode: 'enrichment:mode',
  debounceDays: 'enrichment:debounce_days',
  dailyCap: 'enrichment:daily_cap',
  // Internal — value format is `YYYY-MM-DD:<count>`. Reset implicitly on the
  // first increment of a new UTC date.
  dailyCount: 'enrichment:daily_count',
} as const;

export const ENRICHMENT_MODES = ['structured', 'agentic'] as const;
export type EnrichmentMode = (typeof ENRICHMENT_MODES)[number];

export const enrichmentSettingsSchema = z.object({
  enabled: z.boolean(),
  autoOnCreate: z.boolean(),
  autoOnImport: z.boolean(),
  mode: z.enum(ENRICHMENT_MODES),
  debounceDays: z.number().int().min(0).max(365),
  dailyCap: z.number().int().min(0).max(10_000),
});
export type EnrichmentSettings = z.infer<typeof enrichmentSettingsSchema>;

// PATCH payload: any subset of fields.
export const enrichmentSettingsUpdateSchema = enrichmentSettingsSchema.partial();
export type EnrichmentSettingsUpdate = z.infer<typeof enrichmentSettingsUpdateSchema>;

// What the GET /enrichment/settings endpoint returns when no rows have ever
// been written (every workspace's "out of the box" config). Off by default —
// enrichment costs real Anthropic API tokens, so an operator must explicitly
// opt in.
export const ENRICHMENT_DEFAULTS: EnrichmentSettings = {
  enabled: false,
  autoOnCreate: false,
  autoOnImport: false,
  mode: 'structured',
  debounceDays: 30,
  dailyCap: 100,
};

// Surface for the settings card so users can see how close they are to the
// cap without us exposing the raw counter value format.
export interface EnrichmentUsageDto {
  date: string; // YYYY-MM-DD UTC
  count: number;
  cap: number;
}

// ─── Custom field bootstrap ─────────────────────────────────────────────────
// The `last_enriched_at` field is auto-created on first use so users don't
// have to provision it manually. Stored as a DATETIME custom field on the
// Company entity.
export const ENRICHMENT_LAST_RUN_CUSTOM_FIELD_KEY = 'last_enriched_at';

// ─── Enrichment payload (LLM output contract) ───────────────────────────────
// Every field is optional — the model returns only what it can verify.
// `confidence` carries Claude's self-assessed confidence per field; the
// merge layer can use it to gate writes (currently we don't, but it lands in
// the audit row and the diff modal renders it).

const confidenceSchema = z.enum(['high', 'medium', 'low']);
export type EnrichmentConfidence = z.infer<typeof confidenceSchema>;

const enrichmentSourceSchema = z.object({
  url: z.string().url().max(500),
  fields: z.array(z.string().max(80)).max(40),
});
export type EnrichmentSource = z.infer<typeof enrichmentSourceSchema>;

export const enrichmentPayloadSchema = z.object({
  // null = unable to verify; omitted = not relevant. The route layer collapses
  // both into "skip this field" before applying.
  industry: z.string().max(120).nullable().optional(),
  size: z.string().max(40).nullable().optional(),
  website: z.string().url().max(500).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  addressLine1: z.string().max(200).nullable().optional(),
  addressLine2: z.string().max(200).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  state: z.string().max(80).nullable().optional(),
  postalCode: z.string().max(20).nullable().optional(),
  country: z.string().max(80).nullable().optional(),
  // Markdown summary appended as a polymorphic Note on the company. The
  // prompt asks for 4-8 sentences covering what the company does, who they
  // serve, headquarters, founding year, and any notable recent news.
  summary: z.string().max(4_000).nullable().optional(),
  confidence: z
    .object({
      industry: confidenceSchema.optional(),
      size: confidenceSchema.optional(),
      website: confidenceSchema.optional(),
      phone: confidenceSchema.optional(),
      addressLine1: confidenceSchema.optional(),
      city: confidenceSchema.optional(),
      state: confidenceSchema.optional(),
      postalCode: confidenceSchema.optional(),
      country: confidenceSchema.optional(),
    })
    .optional(),
  sources: z.array(enrichmentSourceSchema).max(20).optional(),
  // Set to true if Claude couldn't disambiguate the company from the inputs;
  // candidates carries the alternatives so the UI can surface a chooser. The
  // worker treats this as a no-op (no fields written, summary still appended
  // explaining the ambiguity).
  ambiguous: z.boolean().optional(),
  candidates: z
    .array(
      z.object({
        name: z.string().max(200),
        website: z.string().url().max(500).optional(),
        reason: z.string().max(400).optional(),
      }),
    )
    .max(5)
    .optional(),
});
export type EnrichmentPayload = z.infer<typeof enrichmentPayloadSchema>;

// What the manual-enrich endpoint returns when called without `apply`.
// Each field carries the existing value, the proposed value, and Claude's
// confidence so the diff modal can render rich rows.
export interface EnrichmentDiffField {
  key: string;
  label: string;
  current: string | null;
  proposed: string | null;
  confidence: EnrichmentConfidence | null;
  // Default per merge policy:
  //   - empty-fill mode: true when current is null/empty AND proposed is set
  //   - manual review: true when proposed differs from current
  // The UI may flip these per checkbox; the apply endpoint trusts the final
  // selection set.
  selectedByDefault: boolean;
}

export interface EnrichmentDiffDto {
  runId: string;
  companyId: number;
  fields: EnrichmentDiffField[];
  summary: string | null;
  sources: EnrichmentSource[];
  ambiguous: boolean;
  candidates:
    | { name: string; website?: string; reason?: string }[]
    | null;
}

// Applied selection — the UI sends back the diff payload with checkboxes
// resolved. We reuse the same field keys; the apply endpoint validates each
// against the original run.
export const enrichmentApplySchema = z.object({
  runId: z.string().min(1).max(60),
  fields: z.array(z.string().min(1).max(80)),
  applySummary: z.boolean().default(true),
});
export type EnrichmentApplyInput = z.infer<typeof enrichmentApplySchema>;

// ─── Merge helpers (shared by api + worker) ─────────────────────────────────
// These let us write the field whitelist + diff builder + note formatter once
// and have both the api's manual-apply route and the worker's auto-apply path
// use the same logic. The shapes are plain (no Prisma dependency) so they
// live here in shared.

export const ENRICHMENT_WRITABLE_FIELDS = [
  'industry',
  'size',
  'website',
  'phone',
  'addressLine1',
  'addressLine2',
  'city',
  'state',
  'postalCode',
] as const;
export type EnrichmentWritableField = (typeof ENRICHMENT_WRITABLE_FIELDS)[number];

export const ENRICHMENT_FIELD_LABELS: Record<EnrichmentWritableField, string> = {
  industry: 'Industry',
  size: 'Size',
  website: 'Website',
  phone: 'Phone',
  addressLine1: 'Address line 1',
  addressLine2: 'Address line 2',
  city: 'City',
  state: 'State',
  postalCode: 'Postal code',
};

/** Subset of Company that `buildEnrichmentDiff` reads. Both apps pass their
 *  Prisma row directly — Prisma's Company type is a superset, so the
 *  structural type accepts it. */
export interface EnrichmentCompanySnapshot {
  id: number;
  industry: string | null;
  website: string | null;
  size: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
}

/** Build the proposed-vs-current diff for a single run. Used by:
 *  - api route GET /enrichment/runs/:id (when status='proposed')
 *  - worker (read-only, e.g. for tests on the manual-trigger return path) */
export function buildEnrichmentDiff(
  runId: string,
  company: EnrichmentCompanySnapshot,
  payload: EnrichmentPayload,
): EnrichmentDiffDto {
  const fields: EnrichmentDiffField[] = [];
  for (const key of ENRICHMENT_WRITABLE_FIELDS) {
    const proposed = payload[key];
    const current = company[key] ?? null;
    if (proposed == null) continue;
    const proposedStr = String(proposed);
    if (current != null && String(current).trim() === proposedStr.trim()) continue;
    const conf =
      payload.confidence?.[key as keyof NonNullable<typeof payload.confidence>] ?? null;
    fields.push({
      key,
      label: ENRICHMENT_FIELD_LABELS[key],
      current,
      proposed: proposedStr,
      confidence: conf,
      selectedByDefault: current == null || String(current).trim() === '',
    });
  }
  return {
    runId,
    companyId: company.id,
    fields,
    summary: payload.summary ?? null,
    sources: payload.sources ?? [],
    ambiguous: payload.ambiguous ?? false,
    candidates: payload.candidates ?? null,
  };
}

/** Format the markdown note body that gets appended to the company on a
 *  successful enrichment. Caller passes today's date so the function stays
 *  pure and testable. */
export function formatEnrichmentNote(
  summary: string,
  sources: EnrichmentSource[],
  ambiguous: boolean,
  candidates:
    | { name: string; website?: string; reason?: string }[]
    | null,
  todayIsoDate: string,
): string {
  const lines: string[] = [];
  lines.push(`**Enriched by Claude on ${todayIsoDate}**`);
  lines.push('');
  if (ambiguous) {
    lines.push('Claude could not unambiguously identify this company. Candidates:');
    for (const c of candidates ?? []) {
      const w = c.website ? ` — ${c.website}` : '';
      const r = c.reason ? ` (${c.reason})` : '';
      lines.push(`- **${c.name}**${w}${r}`);
    }
    lines.push('');
  }
  if (summary) {
    lines.push(summary.trim());
    lines.push('');
  }
  if (sources.length > 0) {
    lines.push('**Sources**');
    for (const s of sources) {
      const fields = s.fields.length > 0 ? ` _(${s.fields.join(', ')})_` : '';
      lines.push(`- ${s.url}${fields}`);
    }
  }
  return lines.join('\n').trim();
}

// EnrichmentRun row surface for the settings UI ("recent runs" list).
export interface EnrichmentRunDto {
  id: string;
  companyId: number;
  companyName: string | null;
  trigger: 'auto-create' | 'auto-import' | 'manual';
  mode: EnrichmentMode;
  // 'pending' covers the moment between row-create and the worker picking
  // up the job — exposed on the wire so the polling client can keep
  // waiting rather than treating an empty status as terminal.
  status: 'pending' | 'applied' | 'proposed' | 'skipped' | 'error';
  reason: string | null;
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
}
