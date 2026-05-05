// Apply an enrichment payload to a Company.
//
// Two policies, selected by `mode`:
//   - 'auto'    → write only fields where the existing value is null/empty.
//                 Used for auto-on-create and auto-on-import.
//   - 'manual'  → don't write anything. Return the diff so the api can
//                 surface it for user confirmation; the apply-with-selections
//                 endpoint then calls `applySelectedEnrichment` below.
//
// In both cases, on a *successful* run we always:
//   - append a polymorphic Note containing the summary + sources
//   - upsert the `last_enriched_at` DATETIME custom field to now()
// On a skipped/error run we write the EnrichmentRun row but don't touch the
// company. The note is the single visible side-effect for users.

import type { Prisma, PrismaClient } from '@prisma/client';
import {
  ENRICHMENT_LAST_RUN_CUSTOM_FIELD_KEY,
  type EnrichmentDiffDto,
  type EnrichmentDiffField,
  type EnrichmentPayload,
  type EnrichmentSource,
} from '@pipelineflow/shared';
import { ensureLastEnrichedAtField } from './bootstrap.js';

type Tx = PrismaClient | Prisma.TransactionClient;

interface ApplyContext {
  runId: string;
  companyId: number;
  payload: EnrichmentPayload;
  /** 'auto' applies empty-fill writes immediately; 'manual' returns a diff
   *  for the UI to confirm without writing. */
  mode: 'auto' | 'manual';
  /** When mode === 'manual', this is the existing company snapshot we
   *  already have — passed in to keep the call signature uniform. */
  company: CompanyShape;
}

interface CompanyShape {
  id: number;
  name: string;
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

// Whitelist of fields the enrichment payload is allowed to write onto the
// Company row. Keep this in sync with the prompt's contract — adding a new
// field here requires updating both the JSON schema (toolSchema.ts) and the
// prompt's "Output contract" section.
// Subset of CompanyShape — the fields the LLM is allowed to write.
type WritableField =
  | 'industry'
  | 'size'
  | 'website'
  | 'phone'
  | 'addressLine1'
  | 'addressLine2'
  | 'city'
  | 'state'
  | 'postalCode';

const FIELD_LABELS: Record<WritableField, string> = {
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

const FIELD_KEYS: WritableField[] = [
  'industry',
  'size',
  'website',
  'phone',
  'addressLine1',
  'addressLine2',
  'city',
  'state',
  'postalCode',
];

export async function applyAuto(
  tx: Tx,
  ctx: ApplyContext,
): Promise<{ status: 'applied' | 'skipped'; reason?: string }> {
  if (ctx.payload.ambiguous) {
    // Don't write fields when Claude flagged the input as ambiguous; we still
    // append the summary note explaining the alternatives so the user can
    // disambiguate.
    await appendNote(tx, ctx);
    await stampLastEnrichedAt(tx, ctx.companyId);
    return { status: 'skipped', reason: 'ambiguous' };
  }

  const updates: Record<string, string> = {};
  for (const key of FIELD_KEYS) {
    const proposed = ctx.payload[key];
    if (proposed == null || proposed === '') continue;
    const current = ctx.company[key];
    if (current != null && String(current).trim() !== '') continue; // empty-fill only
    updates[key] = String(proposed);
  }

  if (Object.keys(updates).length > 0) {
    await tx.company.update({
      where: { id: ctx.companyId },
      data: updates,
    });
  }
  await appendNote(tx, ctx);
  await stampLastEnrichedAt(tx, ctx.companyId);
  return { status: 'applied' };
}

export function buildDiff(ctx: ApplyContext): EnrichmentDiffDto {
  const fields: EnrichmentDiffField[] = [];
  for (const key of FIELD_KEYS) {
    const proposed = ctx.payload[key] ?? null;
    const current = ctx.company[key] ?? null;
    if (proposed == null && current == null) continue;
    if (proposed == null) continue; // Claude declined → nothing to propose
    const proposedStr = typeof proposed === 'string' ? proposed : String(proposed);
    if (current != null && String(current).trim() === proposedStr.trim()) continue;
    const conf = ctx.payload.confidence?.[key as keyof typeof ctx.payload.confidence] ?? null;
    fields.push({
      key,
      label: FIELD_LABELS[key],
      current: current as string | null,
      proposed: proposedStr,
      confidence: conf,
      // Default selection: empty-fill when current is empty, otherwise leave
      // the user to opt-in (they can still tick the box to overwrite).
      selectedByDefault: current == null || String(current).trim() === '',
    });
  }
  return {
    runId: ctx.runId,
    companyId: ctx.companyId,
    fields,
    summary: ctx.payload.summary ?? null,
    sources: ctx.payload.sources ?? [],
    ambiguous: ctx.payload.ambiguous ?? false,
    candidates: ctx.payload.candidates ?? null,
  };
}

/** Apply a user-selected subset of the proposed payload. Called from the
 *  /enrichment/companies/:id/apply route after the user picks fields in the
 *  diff modal. */
export async function applySelected(
  tx: Tx,
  args: {
    runId: string;
    companyId: number;
    payload: EnrichmentPayload;
    selectedFieldKeys: Set<string>;
    applySummary: boolean;
  },
): Promise<void> {
  const updates: Record<string, string> = {};
  for (const key of FIELD_KEYS) {
    if (!args.selectedFieldKeys.has(key)) continue;
    const proposed = args.payload[key];
    if (proposed == null || proposed === '') continue;
    updates[key] = String(proposed);
  }
  if (Object.keys(updates).length > 0) {
    await tx.company.update({
      where: { id: args.companyId },
      data: updates,
    });
  }
  if (args.applySummary && args.payload.summary) {
    await tx.note.create({
      data: {
        companyId: args.companyId,
        content: formatNoteContent(
          args.payload.summary,
          args.payload.sources ?? [],
          args.payload.ambiguous ?? false,
          args.payload.candidates ?? null,
        ),
      },
    });
  }
  await stampLastEnrichedAt(tx, args.companyId);
}

async function appendNote(tx: Tx, ctx: ApplyContext): Promise<void> {
  if (!ctx.payload.summary && !(ctx.payload.ambiguous && ctx.payload.candidates?.length)) {
    return;
  }
  await tx.note.create({
    data: {
      companyId: ctx.companyId,
      content: formatNoteContent(
        ctx.payload.summary ?? '',
        ctx.payload.sources ?? [],
        ctx.payload.ambiguous ?? false,
        ctx.payload.candidates ?? null,
      ),
    },
  });
}

function formatNoteContent(
  summary: string,
  sources: EnrichmentSource[],
  ambiguous: boolean,
  candidates:
    | { name: string; website?: string; reason?: string }[]
    | null,
): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`**Enriched by Claude on ${today}**`);
  lines.push('');
  if (ambiguous) {
    lines.push(
      'Claude could not unambiguously identify this company. Candidates:',
    );
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

async function stampLastEnrichedAt(tx: Tx, companyId: number): Promise<void> {
  const def = await ensureLastEnrichedAtField(tx);
  await tx.customFieldValue.upsert({
    where: {
      definitionId_entityType_entityId: {
        definitionId: def.id,
        entityType: 'COMPANY',
        entityId: companyId,
      },
    },
    create: {
      definitionId: def.id,
      entityType: 'COMPANY',
      entityId: companyId,
      valueDateTime: new Date(),
    },
    update: { valueDateTime: new Date() },
  });
}
