// Apply an enrichment payload to a Company on the auto path. The merge
// policy is empty-fill: only fields where the existing value is null/empty
// get written. Always appends a polymorphic Note + stamps the
// `last_enriched_at` DATETIME custom field.
//
// On a payload flagged `ambiguous` we deliberately skip writes but still
// append the summary note explaining the alternatives — the user has more
// context than Claude does and can disambiguate by editing the company.
//
// Field whitelist + diff builder + note formatter live in
// @pipelineflow/shared so the api's `/runs/:id/apply` route uses the same
// logic for the manual path.

import type { Prisma, PrismaClient } from '@prisma/client';
import {
  ENRICHMENT_WRITABLE_FIELDS,
  buildEnrichmentDiff,
  formatEnrichmentNote,
  type EnrichmentCompanySnapshot,
  type EnrichmentDiffDto,
  type EnrichmentPayload,
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
  /** Existing company snapshot. Both apps pass their Prisma row directly
   *  — the structural type accepts it as a superset of
   *  EnrichmentCompanySnapshot. */
  company: EnrichmentCompanySnapshot;
}

export async function applyAuto(
  tx: Tx,
  ctx: ApplyContext,
): Promise<{ status: 'applied' | 'skipped'; reason?: string }> {
  if (ctx.payload.ambiguous) {
    await appendNote(tx, ctx);
    await stampLastEnrichedAt(tx, ctx.companyId);
    return { status: 'skipped', reason: 'ambiguous' };
  }

  const updates: Record<string, string> = {};
  for (const key of ENRICHMENT_WRITABLE_FIELDS) {
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

/** Re-export of the shared diff builder, bound to the worker's
 *  ApplyContext shape so the test file (and any future caller) keeps the
 *  same call signature regardless of where the function moves. */
export function buildDiff(ctx: ApplyContext): EnrichmentDiffDto {
  return buildEnrichmentDiff(ctx.runId, ctx.company, ctx.payload);
}

async function appendNote(tx: Tx, ctx: ApplyContext): Promise<void> {
  if (!ctx.payload.summary && !(ctx.payload.ambiguous && ctx.payload.candidates?.length)) {
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  await tx.note.create({
    data: {
      companyId: ctx.companyId,
      content: formatEnrichmentNote(
        ctx.payload.summary ?? '',
        ctx.payload.sources ?? [],
        ctx.payload.ambiguous ?? false,
        ctx.payload.candidates ?? null,
        today,
      ),
    },
  });
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
