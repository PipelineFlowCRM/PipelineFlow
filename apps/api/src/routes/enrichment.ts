// Enrichment routes — workspace settings, manual enrich kick-off, run
// polling, apply-diff. Auth-required; no role gating beyond signed-in
// (single-tenant app).
//
// /settings (GET/PATCH)        — back the Settings → Enrichment card
// /ping (POST)                 — tiny Anthropic round-trip for "Test connection"
// /companies/:id (POST)        — kick off a manual enrichment, returns runId
// /runs/:id (GET)              — poll a single run; includes diff once 'proposed'
// /runs/:id/apply (POST)       — write user-selected fields onto the company

import { Router } from 'express';
import {
  enrichmentApplySchema,
  enrichmentPayloadSchema,
  enrichmentSettingsUpdateSchema,
  type EnrichmentDiffDto,
  type EnrichmentDiffField,
  type EnrichmentRunDto,
  type EnrichmentUsageDto,
  type EnrichmentSource,
  type EnrichmentMode,
} from '@pipelineflow/shared';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler, HttpError } from '../lib/error.js';
import { env } from '../env.js';
import {
  getDailyUsage,
  readEnrichmentSettings,
  writeEnrichmentSettings,
} from '../lib/enrichment/settings.js';
import { kickoffEnrichment } from '../lib/enrichment/enqueue.js';
import { ensureLastEnrichedAtField } from '../lib/enrichment/bootstrap.js';
import { logger } from '../lib/logger.js';

export const enrichmentRouter = Router();
enrichmentRouter.use(requireAuth);

/** Fail-soft 503 when the operator hasn't configured an API key. The settings
 *  card uses the response shape to render an explanatory banner. */
function requireConfigured(): void {
  if (!env.ANTHROPIC_API_KEY) {
    throw new HttpError(503, 'Anthropic isn\'t configured on this server');
  }
}

enrichmentRouter.get(
  '/settings',
  asyncHandler(async (_req, res) => {
    const settings = await readEnrichmentSettings();
    const usage = await getDailyUsage();
    const usageDto: EnrichmentUsageDto = {
      date: usage.date,
      count: usage.count,
      cap: settings.dailyCap,
    };
    res.json({
      settings,
      usage: usageDto,
      configured: Boolean(env.ANTHROPIC_API_KEY),
      model: env.ANTHROPIC_MODEL,
    });
  }),
);

enrichmentRouter.patch(
  '/settings',
  asyncHandler(async (req, res) => {
    const patch = enrichmentSettingsUpdateSchema.parse(req.body);
    // If the operator hasn't set an API key, we still accept settings writes
    // (so they can pre-stage the toggles before flipping the env). The
    // *runtime* enforcement happens at job-enqueue time — see Phase 8.
    const settings = await writeEnrichmentSettings(patch);
    const usage = await getDailyUsage();
    res.json({
      settings,
      usage: { date: usage.date, count: usage.count, cap: settings.dailyCap },
      configured: Boolean(env.ANTHROPIC_API_KEY),
      model: env.ANTHROPIC_MODEL,
    });
  }),
);

/** Manually trigger enrichment of a single company. Returns the runId
 *  immediately; the client polls GET /runs/:id until the row reaches a
 *  terminal status (proposed | error | skipped). On 'proposed', the diff
 *  endpoint returns the field-by-field comparison for the user to review. */
enrichmentRouter.post(
  '/companies/:id',
  asyncHandler(async (req, res) => {
    requireConfigured();
    const id = Number(String(req.params.id ?? ''));
    if (!Number.isInteger(id) || id <= 0) {
      throw new HttpError(400, 'Invalid company id');
    }
    // Manual enrich bypasses the auto-on-create / auto-on-import gates but
    // still respects `enabled`, the daily cap, and the API key — same as
    // the worker's authoritative gating.
    const result = await kickoffEnrichment({
      companyId: id,
      trigger: 'manual',
      actorUserId: req.user!.id,
    });
    if (!result.enqueued) {
      // The kickoff helper never enqueues when the feature is disabled or
      // unconfigured; manual triggers should still surface the reason as a
      // 409 so the UI can render an explanatory message.
      throw new HttpError(
        409,
        `Enrichment cannot run: ${result.reason ?? 'unknown'}`,
      );
    }
    res.status(202).json({ runId: result.runId });
  }),
);

/** Poll a single run. Returns the run row + (when status='proposed') the
 *  rendered diff that the modal needs to display proposed-vs-current. */
enrichmentRouter.get(
  '/runs/:id',
  asyncHandler(async (req, res) => {
    const runId = String(req.params.id ?? '');
    if (!runId) throw new HttpError(400, 'Invalid run id');
    const run = await prisma.enrichmentRun.findUnique({ where: { id: runId } });
    if (!run) throw new HttpError(404, 'Run not found');

    const dto: EnrichmentRunDto = {
      id: run.id,
      companyId: run.companyId ?? -1,
      companyName: run.companyName,
      trigger: run.trigger as EnrichmentRunDto['trigger'],
      mode: run.mode as EnrichmentMode,
      status: run.status as EnrichmentRunDto['status'],
      reason: run.reason,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      errorMessage: run.errorMessage,
    };

    let diff: EnrichmentDiffDto | null = null;
    if (run.status === 'proposed' && run.payload && run.companyId != null) {
      const company = await prisma.company.findUnique({ where: { id: run.companyId } });
      if (company) {
        const parsed = enrichmentPayloadSchema.safeParse(run.payload);
        if (parsed.success) {
          diff = renderDiff(run.id, company, parsed.data);
        }
      }
    }
    res.json({ run: dto, diff });
  }),
);

/** Apply user-selected fields from a 'proposed' run to the company. The
 *  client sends the runId + the keys it wants written; we re-validate the
 *  stored payload and write only those fields. The summary note + the
 *  last_enriched_at stamp are always applied (the run already happened —
 *  the audit trail belongs on the company regardless of which fields the
 *  user picked). */
enrichmentRouter.post(
  '/runs/:id/apply',
  asyncHandler(async (req, res) => {
    const runId = String(req.params.id ?? '');
    if (!runId) throw new HttpError(400, 'Invalid run id');
    const input = enrichmentApplySchema.parse({ ...req.body, runId });
    const run = await prisma.enrichmentRun.findUnique({ where: { id: runId } });
    if (!run) throw new HttpError(404, 'Run not found');
    if (run.status !== 'proposed') {
      throw new HttpError(409, `Run is not in 'proposed' state (current: ${run.status})`);
    }
    if (run.companyId == null) {
      throw new HttpError(409, 'Company has been deleted');
    }
    const parsed = enrichmentPayloadSchema.safeParse(run.payload);
    if (!parsed.success) {
      throw new HttpError(500, 'Stored enrichment payload failed validation');
    }
    const payload = parsed.data;
    const selected = new Set(input.fields);

    await prisma.$transaction(async (tx) => {
      const updates: Record<string, string> = {};
      for (const key of WRITABLE_FIELDS) {
        if (!selected.has(key)) continue;
        const v = (payload as Record<string, unknown>)[key];
        if (v == null || v === '') continue;
        updates[key] = String(v);
      }
      if (Object.keys(updates).length > 0) {
        await tx.company.update({ where: { id: run.companyId! }, data: updates });
      }
      if (input.applySummary && payload.summary) {
        await tx.note.create({
          data: {
            companyId: run.companyId!,
            createdBy: req.user!.id,
            content: formatNoteFromPayload(
              payload.summary,
              payload.sources ?? [],
              payload.ambiguous ?? false,
              payload.candidates ?? null,
            ),
          },
        });
      }
      const def = await ensureLastEnrichedAtField(tx);
      await tx.customFieldValue.upsert({
        where: {
          definitionId_entityType_entityId: {
            definitionId: def.id,
            entityType: 'COMPANY',
            entityId: run.companyId!,
          },
        },
        create: {
          definitionId: def.id,
          entityType: 'COMPANY',
          entityId: run.companyId!,
          valueDateTime: new Date(),
        },
        update: { valueDateTime: new Date() },
      });
      await tx.enrichmentRun.update({
        where: { id: runId },
        data: { status: 'applied', finishedAt: new Date() },
      });
    });
    res.json({ ok: true });
  }),
);

/** Tiny Anthropic round-trip for the "Test connection" button. Uses minimal
 *  output tokens to keep cost negligible. */
enrichmentRouter.post(
  '/ping',
  asyncHandler(async (_req, res) => {
    requireConfigured();
    // Lazy-import so the SDK isn't loaded into memory in environments that
    // never enable enrichment.
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    try {
      const result = await client.messages.create({
        model: env.ANTHROPIC_MODEL,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'pong' }],
      });
      res.json({
        ok: true,
        model: result.model,
        stopReason: result.stop_reason,
      });
    } catch (err) {
      logger.warn({ err }, 'enrichment ping failed');
      const msg = err instanceof Error ? err.message : 'Anthropic call failed';
      throw new HttpError(502, msg);
    }
  }),
);

// ─── Helpers ────────────────────────────────────────────────────────────────

// Whitelist of writable fields. Mirror of FIELD_KEYS in the worker's
// applyEnrichment.ts — kept here so the api-side apply path doesn't depend
// on worker internals. Keep these in lockstep.
const WRITABLE_FIELDS = [
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

const FIELD_LABELS: Record<string, string> = {
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

function renderDiff(
  runId: string,
  company: {
    id: number;
    industry: string | null;
    size: string | null;
    website: string | null;
    phone: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
  },
  payload: import('@pipelineflow/shared').EnrichmentPayload,
): EnrichmentDiffDto {
  const fields: EnrichmentDiffField[] = [];
  for (const key of WRITABLE_FIELDS) {
    const proposed = (payload as Record<string, unknown>)[key];
    const current = (company as Record<string, unknown>)[key] ?? null;
    if (proposed == null) continue;
    const proposedStr = String(proposed);
    if (current != null && String(current).trim() === proposedStr.trim()) continue;
    const conf = payload.confidence?.[key as keyof typeof payload.confidence] ?? null;
    fields.push({
      key,
      label: FIELD_LABELS[key] ?? key,
      current: current as string | null,
      proposed: proposedStr,
      confidence: conf,
      selectedByDefault:
        current == null || String(current).trim() === '',
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

function formatNoteFromPayload(
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
