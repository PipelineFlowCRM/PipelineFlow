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
  ENRICHMENT_WRITABLE_FIELDS,
  buildEnrichmentDiff,
  enrichmentApplySchema,
  enrichmentPayloadSchema,
  enrichmentSettingsUpdateSchema,
  formatEnrichmentNote,
  type EnrichmentRunDto,
  type EnrichmentUsageDto,
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
import { rateLimit } from '../lib/rateLimit.js';
import { logger } from '../lib/logger.js';

export const enrichmentRouter = Router();
enrichmentRouter.use(requireAuth);

// Per-user rate limit on the manual-trigger endpoint. The worker's daily
// cap is the cost-side backstop, but it only kicks in *after* the LLM call
// — a user spam-clicking "Enrich" can fan out tens of in-flight jobs
// against the same company before any of them increment the counter.
// 10/min is generous for legitimate exploration and tight enough to make
// runaway click loops boring. Keyed by user id so the limit is per-actor,
// not per-IP (the latter would penalize a whole NAT'd office).
const manualEnrichLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  keyFn: (req) => `enrich-manual:${req.user?.id ?? req.ip ?? 'anon'}`,
  message: 'Too many enrichment requests, slow down',
});

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
  manualEnrichLimiter,
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

    let diff: ReturnType<typeof buildEnrichmentDiff> | null = null;
    if (run.status === 'proposed' && run.payload && run.companyId != null) {
      const company = await prisma.company.findUnique({ where: { id: run.companyId } });
      if (company) {
        const parsed = enrichmentPayloadSchema.safeParse(run.payload);
        if (parsed.success) {
          diff = buildEnrichmentDiff(run.id, company, parsed.data);
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
      for (const key of ENRICHMENT_WRITABLE_FIELDS) {
        if (!selected.has(key)) continue;
        const v = (payload as Record<string, unknown>)[key];
        if (v == null || v === '') continue;
        updates[key] = String(v);
      }
      if (Object.keys(updates).length > 0) {
        await tx.company.update({ where: { id: run.companyId! }, data: updates });
      }
      if (input.applySummary && payload.summary) {
        const today = new Date().toISOString().slice(0, 10);
        // Leave createdBy unset — both enrichment paths (auto + this manual
        // apply) attribute the note to the system, not the user who clicked
        // Apply. The "Enriched by Claude on …" header in the body makes the
        // origin unambiguous; a user attribution here would imply "Bob
        // wrote this" when in fact Claude did.
        await tx.note.create({
          data: {
            companyId: run.companyId!,
            content: formatEnrichmentNote(
              payload.summary,
              payload.sources ?? [],
              payload.ambiguous ?? false,
              payload.candidates ?? null,
              today,
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
 *  output tokens to keep cost negligible, and a 10s wall-clock timeout so a
 *  slow Anthropic doesn't leave the settings page hanging. */
enrichmentRouter.post(
  '/ping',
  asyncHandler(async (_req, res) => {
    requireConfigured();
    // Lazy-import so the SDK isn't loaded into memory in environments that
    // never enable enrichment.
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    try {
      const result = await client.messages.create(
        {
          model: env.ANTHROPIC_MODEL,
          max_tokens: 8,
          messages: [{ role: 'user', content: 'pong' }],
        },
        { timeout: 10_000 },
      );
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

// Field whitelist + diff builder + note formatter live in
// @pipelineflow/shared (see ENRICHMENT_WRITABLE_FIELDS / buildEnrichmentDiff
// / formatEnrichmentNote) so the worker's auto path uses the same logic.
