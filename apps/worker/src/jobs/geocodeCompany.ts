// Worker processor for the company-geocoding queue.
//
// Lifecycle:
//   1. Token check — empty MAPBOX_API_TOKEN → write geocodingStatus
//      ='failed' with a human message, return 'skipped'. Don't throw — a
//      retry won't fix a missing token.
//   2. Re-read the company by id (latest address — the user might have
//      edited between enqueue and pickup).
//   3. Re-check `isFullAddress`. If the address became incomplete after
//      enqueue, mark failed and return.
//   4. Call Mapbox Geocoding API (forward geocoding: address → coordinates).
//      - Non-2xx response → throw so BullMQ retries with exponential
//        backoff. Status stays 'pending' across in-flight retries; only
//        the FINAL failed attempt flips the row to 'failed'. The UI's
//        polling keys off 'pending', so flipping early would stop the
//        poll and a subsequent successful retry would never be seen.
//      - Zero features → permanent fail, mark 'failed' and return
//        'not-found' (no throw — retries won't find a missing place).
//      - 1+ features → write latitude/longitude/geocodedAt, clear status
//        and error, return 'geocoded'.

import type { Job } from 'bullmq';
import {
  formatAddressQuery,
  isFullAddress,
  type GeocodeCompanyJobData,
  type GeocodeCompanyJobResult,
} from '@pipelineflow/shared';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { env } from '../env.js';

const MAPBOX_BASE = 'https://api.mapbox.com/geocoding/v5/mapbox.places';

export async function processGeocodeCompany(
  job: Job<GeocodeCompanyJobData>,
): Promise<GeocodeCompanyJobResult> {
  const { companyId } = job.data;

  if (!env.MAPBOX_API_TOKEN) {
    await markFailed(companyId, "Mapbox isn't configured on this server.");
    return { status: 'skipped', reason: 'not-configured' };
  }

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: {
      id: true,
      addressLine1: true,
      city: true,
      state: true,
      postalCode: true,
    },
  });
  if (!company) {
    return { status: 'skipped', reason: 'company-deleted' };
  }
  if (!isFullAddress(company)) {
    await markFailed(companyId, 'Address became incomplete before geocoding.');
    return { status: 'skipped', reason: 'incomplete' };
  }

  const query = formatAddressQuery(company);
  // Snapshot the exact string we sent to Mapbox so the UI can detect
  // staleness by comparing the current formatted address against this
  // value. Held in a const because the Prisma update is below.
  const snapshot = query;
  const url =
    `${MAPBOX_BASE}/${encodeURIComponent(query)}.json` +
    `?access_token=${encodeURIComponent(env.MAPBOX_API_TOKEN)}` +
    `&country=us&limit=1&types=address,postcode`;

  // Whether this run is the last BullMQ will attempt. attemptsMade is the
  // count of *previous* completed attempts, so the current run is final
  // when attemptsMade + 1 >= configured attempts. Default to 1 if attempts
  // wasn't set on the job (defensive).
  const isFinalAttempt =
    (job.attemptsMade ?? 0) + 1 >= (job.opts?.attempts ?? 1);

  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network error';
    if (isFinalAttempt) {
      await markFailed(companyId, `Mapbox request failed: ${message}`);
    }
    throw err; // BullMQ retry
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const message = `Mapbox returned ${res.status}: ${truncate(body, 200)}`;
    if (isFinalAttempt) {
      await markFailed(companyId, message);
    }
    throw new Error(message);
  }

  const json = (await res.json()) as MapboxGeocodingResponse;
  const feature = json.features?.[0];
  if (!feature) {
    await markFailed(companyId, 'Address not found by Mapbox.');
    return { status: 'not-found' };
  }

  // Mapbox returns [longitude, latitude] in feature.center.
  const [lng, lat] = feature.center;
  if (typeof lng !== 'number' || typeof lat !== 'number') {
    await markFailed(companyId, 'Mapbox returned a malformed coordinate.');
    return { status: 'error', reason: 'bad-coordinate' };
  }

  await prisma.company.update({
    where: { id: companyId },
    data: {
      latitude: lat,
      longitude: lng,
      geocodedAt: new Date(),
      geocodedAddress: snapshot,
      geocodingStatus: null,
      geocodingError: null,
    },
  });
  logger.info({ companyId, lat, lng }, 'company geocoded');
  return { status: 'geocoded' };
}

async function markFailed(companyId: number, error: string): Promise<void> {
  await prisma.company.update({
    where: { id: companyId },
    data: { geocodingStatus: 'failed', geocodingError: error },
  });
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

interface MapboxGeocodingResponse {
  features?: Array<{
    center: [number, number]; // [lng, lat]
  }>;
}
