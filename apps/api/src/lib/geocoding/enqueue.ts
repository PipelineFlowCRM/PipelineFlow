// Single entry point for kicking off a company geocode. Today only the
// manual button on the company detail page calls this; future auto triggers
// (post-create, CSV import, address-change) can funnel through here too.
//
// Mirrors the enrichment kickoff pattern: validate locally, flip the row's
// status to 'pending' so the UI reflects the queued state immediately, then
// enqueue. On enqueue failure roll the status back so a stale spinner
// doesn't sit in the UI forever.

import { prisma } from '../../db.js';
import { isFullAddress } from '@pipelineflow/shared';
import { enqueueGeocodeCompany } from '../queue.js';
import { logger } from '../logger.js';

export type KickoffReason =
  | 'company-not-found'
  | 'incomplete-address'
  | 'enqueue-failed';

export interface KickoffResult {
  enqueued: boolean;
  reason?: KickoffReason;
}

export async function kickoffGeocode(args: {
  companyId: number;
}): Promise<KickoffResult> {
  const company = await prisma.company.findUnique({
    where: { id: args.companyId },
    select: {
      id: true,
      addressLine1: true,
      city: true,
      state: true,
      postalCode: true,
    },
  });
  if (!company) {
    return { enqueued: false, reason: 'company-not-found' };
  }
  if (!isFullAddress(company)) {
    return { enqueued: false, reason: 'incomplete-address' };
  }

  // Flip the row to 'pending' BEFORE enqueueing so a refetch right after the
  // POST returns sees the new state, and a worker picking the job up
  // immediately doesn't race with this update.
  await prisma.company.update({
    where: { id: company.id },
    data: { geocodingStatus: 'pending', geocodingError: null },
  });

  try {
    await enqueueGeocodeCompany({ companyId: company.id, trigger: 'manual' });
  } catch (err) {
    logger.error(
      { err, companyId: company.id },
      'failed to enqueue geocode-company',
    );
    await prisma.company.update({
      where: { id: company.id },
      data: {
        geocodingStatus: 'failed',
        geocodingError: 'Failed to enqueue worker job',
      },
    });
    return { enqueued: false, reason: 'enqueue-failed' };
  }

  return { enqueued: true };
}
