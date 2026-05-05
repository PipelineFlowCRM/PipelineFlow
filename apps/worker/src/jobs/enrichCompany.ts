// Worker processor for the company-enrichment queue.
//
// Lifecycle:
//   1. Re-read the EnrichmentRun row + Company snapshot. The api pre-created
//      the run with status='pending'; we update it as we go.
//   2. Settings + guardrail checks: enabled, dailyCap, debounce. Any guard
//      that trips → status='skipped' and we return without calling Anthropic.
//   3. Run the LLM in the configured mode (structured | agentic).
//   4. For 'auto' triggers, write empty-fill changes immediately, append the
//      summary note, stamp last_enriched_at. status='applied'.
//      For 'manual' triggers, persist the payload on the run row and stop.
//      status='proposed' — the api's /apply endpoint commits user-selected
//      fields when the user confirms.
//   5. Bump the daily counter on any non-skipped run (LLM call happened).
//   6. Errors → status='error', errorMessage saved. The job is retryable;
//      attempts are capped at 2 (see queue.ts).

import type { Job } from 'bullmq';
import {
  ENRICHMENT_LAST_RUN_CUSTOM_FIELD_KEY,
  type EnrichCompanyJobData,
  type EnrichCompanyJobResult,
} from '@pipelineflow/shared';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { env } from '../env.js';
import {
  getDailyUsage,
  incrementDailyUsage,
  readEnrichmentSettings,
} from '../lib/enrichment/settings.js';
import { runStructured } from '../lib/enrichment/runStructured.js';
import { runAgentic } from '../lib/enrichment/runAgentic.js';
import { applyAuto } from '../lib/enrichment/applyEnrichment.js';
import { ensureLastEnrichedAtField } from '../lib/enrichment/bootstrap.js';
import { AnthropicNotConfiguredError } from '../lib/enrichment/client.js';
import type { CompanySnapshot } from '../lib/enrichment/prompt.js';

export async function processEnrichCompany(
  job: Job<EnrichCompanyJobData>,
): Promise<EnrichCompanyJobResult> {
  const { companyId, runId, trigger } = job.data;
  const settings = await readEnrichmentSettings();

  // Guardrails — short-circuit before calling Anthropic.
  if (!settings.enabled) {
    return finishSkipped(runId, 'disabled');
  }
  if (!env.ANTHROPIC_API_KEY) {
    return finishSkipped(runId, 'not-configured');
  }
  const usage = await getDailyUsage();
  if (usage.count >= settings.dailyCap) {
    return finishSkipped(runId, 'daily-cap-reached');
  }
  if (trigger !== 'manual' && (await isWithinDebounce(companyId, settings.debounceDays))) {
    return finishSkipped(runId, 'debounce');
  }

  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) {
    return finishSkipped(runId, 'company-deleted');
  }

  // Mark the run row as in-flight and capture mode (the row was created with
  // a placeholder mode by the api; the worker is the source of truth for the
  // mode actually used).
  await prisma.enrichmentRun.update({
    where: { id: runId },
    data: { mode: settings.mode, status: 'pending' },
  });

  const snapshot: CompanySnapshot = {
    id: company.id,
    name: company.name,
    industry: company.industry,
    website: company.website,
    size: company.size,
    phone: company.phone,
    addressLine1: company.addressLine1,
    addressLine2: company.addressLine2,
    city: company.city,
    state: company.state,
    postalCode: company.postalCode,
    notes: company.notes,
  };

  let payload;
  try {
    const result =
      settings.mode === 'agentic'
        ? await runAgentic(snapshot)
        : await runStructured(snapshot);
    payload = result.payload;
    logger.info(
      {
        runId,
        companyId,
        mode: settings.mode,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheCreationTokens: result.cacheCreationTokens,
        cacheReadTokens: result.cacheReadTokens,
      },
      'enrichment llm call completed',
    );
  } catch (err) {
    if (err instanceof AnthropicNotConfiguredError) {
      return finishSkipped(runId, 'not-configured');
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    await prisma.enrichmentRun.update({
      where: { id: runId },
      data: { status: 'error', errorMessage: message, finishedAt: new Date() },
    });
    throw err; // let BullMQ apply its retry policy
  }

  // The LLM call succeeded — count it against the daily cap regardless of
  // whether we then write fields (manual triggers don't write but the API
  // call still cost money).
  await incrementDailyUsage();

  if (trigger === 'manual') {
    // Manual runs land as 'proposed' — the api's GET /runs/:id endpoint
    // re-builds the diff from the persisted payload at read time.
    await prisma.enrichmentRun.update({
      where: { id: runId },
      data: {
        status: 'proposed',
        payload: payload as object,
        finishedAt: new Date(),
      },
    });
    return { status: 'proposed', runId };
  }

  // Auto path — atomic write of fields + note + last_enriched_at.
  const result = await prisma.$transaction(async (tx) => {
    return applyAuto(tx, {
      runId,
      companyId,
      payload,
      mode: 'auto',
      company: snapshot,
    });
  });

  await prisma.enrichmentRun.update({
    where: { id: runId },
    data: {
      status: result.status,
      reason: result.reason ?? null,
      payload: payload as object,
      finishedAt: new Date(),
    },
  });
  return { status: result.status, reason: result.reason, runId };
}

async function finishSkipped(
  runId: string,
  reason: string,
): Promise<EnrichCompanyJobResult> {
  await prisma.enrichmentRun.update({
    where: { id: runId },
    data: { status: 'skipped', reason, finishedAt: new Date() },
  });
  return { status: 'skipped', reason, runId };
}

/** Returns true if the company's `last_enriched_at` custom field is newer
 *  than `debounceDays` ago. Looks the field up by key (it may not exist
 *  yet, in which case there's nothing to debounce). */
async function isWithinDebounce(
  companyId: number,
  debounceDays: number,
): Promise<boolean> {
  if (debounceDays <= 0) return false;
  const def = await prisma.customFieldDefinition.findUnique({
    where: {
      entityType_key: {
        entityType: 'COMPANY',
        key: ENRICHMENT_LAST_RUN_CUSTOM_FIELD_KEY,
      },
    },
    select: { id: true },
  });
  if (!def) return false; // field not bootstrapped yet — nothing to compare against
  const row = await prisma.customFieldValue.findUnique({
    where: {
      definitionId_entityType_entityId: {
        definitionId: def.id,
        entityType: 'COMPANY',
        entityId: companyId,
      },
    },
    select: { valueDateTime: true },
  });
  if (!row?.valueDateTime) return false;
  const ageMs = Date.now() - row.valueDateTime.getTime();
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  return ageDays < debounceDays;
}

// Imported here so callers don't need to also reach into the bootstrap helper
// directly when they want to make sure the field exists — useful from the
// api's settings GET endpoint when enrichment first turns on.
export { ensureLastEnrichedAtField };
