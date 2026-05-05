// Single entry point for kicking off a company enrichment. Both the auto
// triggers (companies POST, CSV importer) and the manual button on the
// company detail page funnel through this — the EnrichmentRun row is
// pre-allocated here so the manual flow can return a runId immediately
// for the UI to poll on.
//
// The settings + key checks are *advisory* on this side. The worker does
// the authoritative gating again at job-start (settings could flip
// between enqueue and dequeue, the daily cap could fill mid-import,
// etc.). Doing the check here too short-circuits the no-op cases without
// even touching Redis.

import { prisma } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../logger.js';
import { enqueueEnrichCompany } from '../queue.js';
import { readEnrichmentSettings } from './settings.js';

export interface KickoffArgs {
  companyId: number;
  trigger: 'auto-create' | 'auto-import' | 'manual';
  actorUserId?: number | null;
}

export interface KickoffResult {
  enqueued: boolean;
  runId: string | null;
  reason?: string;
}

/** Pre-allocate an EnrichmentRun row + enqueue the job. Returns the runId
 *  so the caller (manual route) can hand it back to the client for polling.
 *  Auto callers can ignore the runId and rely on the company-detail view
 *  to surface the appended note + last_enriched_at when it lands. */
export async function kickoffEnrichment(args: KickoffArgs): Promise<KickoffResult> {
  if (!env.ANTHROPIC_API_KEY) {
    return { enqueued: false, runId: null, reason: 'not-configured' };
  }
  const settings = await readEnrichmentSettings();
  if (!settings.enabled) {
    return { enqueued: false, runId: null, reason: 'disabled' };
  }
  if (args.trigger === 'auto-create' && !settings.autoOnCreate) {
    return { enqueued: false, runId: null, reason: 'auto-on-create-disabled' };
  }
  if (args.trigger === 'auto-import' && !settings.autoOnImport) {
    return { enqueued: false, runId: null, reason: 'auto-on-import-disabled' };
  }

  const company = await prisma.company.findUnique({
    where: { id: args.companyId },
    select: { id: true, name: true },
  });
  if (!company) {
    return { enqueued: false, runId: null, reason: 'company-not-found' };
  }

  const run = await prisma.enrichmentRun.create({
    data: {
      companyId: company.id,
      companyName: company.name,
      trigger: args.trigger,
      // The worker overwrites this with whatever mode it actually used; we
      // store the *currently configured* mode here for visibility, since
      // the row exists before the worker has even read it.
      mode: settings.mode,
      status: 'pending',
    },
    select: { id: true },
  });

  try {
    await enqueueEnrichCompany({
      companyId: company.id,
      runId: run.id,
      trigger: args.trigger,
      actorUserId: args.actorUserId ?? null,
    });
  } catch (err) {
    logger.error(
      { err, runId: run.id, companyId: company.id },
      'failed to enqueue enrichment',
    );
    await prisma.enrichmentRun.update({
      where: { id: run.id },
      data: {
        status: 'error',
        errorMessage: 'Failed to enqueue worker job',
        finishedAt: new Date(),
      },
    });
    return { enqueued: false, runId: run.id, reason: 'enqueue-failed' };
  }

  return { enqueued: true, runId: run.id };
}
