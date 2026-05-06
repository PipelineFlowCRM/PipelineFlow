// Tests for the geocode-company processor — token gating, address gating,
// Mapbox response branches, and the retry-vs-final-attempt distinction
// that keeps the UI's polling loop alive across transient failures.

import type { Job } from 'bullmq';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  GeocodeCompanyJobData,
  GeocodeCompanyJobResult,
} from '@pipelineflow/shared';

const prismaMocks = vi.hoisted(() => ({
  company: { findUnique: vi.fn(), update: vi.fn() },
}));

const envMocks = vi.hoisted(() => ({
  MAPBOX_API_TOKEN: 'pk.test-token',
}));

vi.mock('../db.js', () => ({ prisma: prismaMocks }));
vi.mock('../env.js', () => ({ env: envMocks }));

const { processGeocodeCompany } = await import('./geocodeCompany.js');

type FakeJob = Job<GeocodeCompanyJobData, GeocodeCompanyJobResult>;

function fakeJob(
  overrides: { attemptsMade?: number; attempts?: number } = {},
): FakeJob {
  return {
    id: 'job-1',
    name: 'geocode-company',
    data: { companyId: 42, trigger: 'manual' },
    attemptsMade: overrides.attemptsMade ?? 0,
    opts: { attempts: overrides.attempts ?? 3 },
  } as unknown as FakeJob;
}

const fullCompany = {
  id: 42,
  addressLine1: '350 5th Ave',
  city: 'New York',
  state: 'NY',
  postalCode: '10118',
};

function setFetch(stub: unknown): void {
  (globalThis as { fetch: unknown }).fetch = stub;
}

function mockFetchOk(features: Array<{ center: [number, number] }>) {
  setFetch(
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ features }),
    }),
  );
}

function mockFetchHttp(status: number, body = '') {
  setFetch(
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      text: async () => body,
    }),
  );
}

function mockFetchThrow(err: Error) {
  setFetch(vi.fn().mockRejectedValue(err));
}

beforeEach(() => {
  vi.clearAllMocks();
  envMocks.MAPBOX_API_TOKEN = 'pk.test-token';
});

describe('processGeocodeCompany', () => {
  it('skips and marks failed when MAPBOX_API_TOKEN is empty', async () => {
    envMocks.MAPBOX_API_TOKEN = '';
    prismaMocks.company.update.mockResolvedValue({});

    const result = await processGeocodeCompany(fakeJob());

    expect(result).toEqual({ status: 'skipped', reason: 'not-configured' });
    expect(prismaMocks.company.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: {
        geocodingStatus: 'failed',
        geocodingError: "Mapbox isn't configured on this server.",
      },
    });
    expect(prismaMocks.company.findUnique).not.toHaveBeenCalled();
  });

  it('skips silently when the company was deleted between enqueue and run', async () => {
    prismaMocks.company.findUnique.mockResolvedValue(null);

    const result = await processGeocodeCompany(fakeJob());

    expect(result).toEqual({ status: 'skipped', reason: 'company-deleted' });
    // Don't write to a non-existent row.
    expect(prismaMocks.company.update).not.toHaveBeenCalled();
  });

  it('marks failed when the address became incomplete after enqueue', async () => {
    prismaMocks.company.findUnique.mockResolvedValue({
      ...fullCompany,
      postalCode: null,
    });
    prismaMocks.company.update.mockResolvedValue({});

    const result = await processGeocodeCompany(fakeJob());

    expect(result).toEqual({ status: 'skipped', reason: 'incomplete' });
    expect(prismaMocks.company.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: {
        geocodingStatus: 'failed',
        geocodingError: 'Address became incomplete before geocoding.',
      },
    });
  });

  it('writes lat/lng/snapshot and clears status on a successful Mapbox response', async () => {
    prismaMocks.company.findUnique.mockResolvedValue(fullCompany);
    prismaMocks.company.update.mockResolvedValue({});
    mockFetchOk([{ center: [-73.9857, 40.7484] }]);

    const result = await processGeocodeCompany(fakeJob());

    expect(result).toEqual({ status: 'geocoded' });
    const updateCall = prismaMocks.company.update.mock.calls[0]?.[0];
    expect(updateCall).toMatchObject({
      where: { id: 42 },
      data: {
        latitude: 40.7484,
        longitude: -73.9857,
        geocodedAddress: '350 5th Ave, New York, NY, 10118',
        geocodingStatus: null,
        geocodingError: null,
      },
    });
    // geocodedAt is a Date — don't pin its value, just confirm it's there.
    expect(updateCall?.data?.geocodedAt).toBeInstanceOf(Date);
  });

  it('marks failed and returns not-found when Mapbox returns zero features', async () => {
    prismaMocks.company.findUnique.mockResolvedValue(fullCompany);
    prismaMocks.company.update.mockResolvedValue({});
    mockFetchOk([]);

    const result = await processGeocodeCompany(fakeJob());

    expect(result).toEqual({ status: 'not-found' });
    expect(prismaMocks.company.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: {
        geocodingStatus: 'failed',
        geocodingError: 'Address not found by Mapbox.',
      },
    });
  });

  it('does NOT mark failed on a non-final attempt (still throws so BullMQ retries)', async () => {
    prismaMocks.company.findUnique.mockResolvedValue(fullCompany);
    prismaMocks.company.update.mockResolvedValue({});
    mockFetchHttp(503, 'Service Unavailable');

    // attempt 1 of 3 — not the final attempt
    await expect(
      processGeocodeCompany(fakeJob({ attemptsMade: 0, attempts: 3 })),
    ).rejects.toThrow(/Mapbox returned 503/);

    // The row stays 'pending' (no markFailed call) so the UI keeps polling
    // and a subsequent successful retry will be picked up.
    expect(prismaMocks.company.update).not.toHaveBeenCalled();
  });

  it('marks failed on the final attempt, then throws so BullMQ records the failure', async () => {
    prismaMocks.company.findUnique.mockResolvedValue(fullCompany);
    prismaMocks.company.update.mockResolvedValue({});
    mockFetchHttp(503, 'Service Unavailable');

    // attempt 3 of 3 — last attempt
    await expect(
      processGeocodeCompany(fakeJob({ attemptsMade: 2, attempts: 3 })),
    ).rejects.toThrow(/Mapbox returned 503/);

    expect(prismaMocks.company.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: {
        geocodingStatus: 'failed',
        geocodingError: expect.stringContaining('Mapbox returned 503'),
      },
    });
  });

  it('treats a network error the same way: silent during retries, marked on final', async () => {
    prismaMocks.company.findUnique.mockResolvedValue(fullCompany);
    prismaMocks.company.update.mockResolvedValue({});
    mockFetchThrow(new Error('ECONNRESET'));

    // Non-final → no DB update.
    await expect(
      processGeocodeCompany(fakeJob({ attemptsMade: 0, attempts: 3 })),
    ).rejects.toThrow('ECONNRESET');
    expect(prismaMocks.company.update).not.toHaveBeenCalled();

    // Final → marks failed.
    mockFetchThrow(new Error('ECONNRESET'));
    await expect(
      processGeocodeCompany(fakeJob({ attemptsMade: 2, attempts: 3 })),
    ).rejects.toThrow('ECONNRESET');
    expect(prismaMocks.company.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: {
        geocodingStatus: 'failed',
        geocodingError: expect.stringContaining('ECONNRESET'),
      },
    });
  });

  it('rejects malformed coordinates without throwing', async () => {
    prismaMocks.company.findUnique.mockResolvedValue(fullCompany);
    prismaMocks.company.update.mockResolvedValue({});
    mockFetchOk([
      { center: ['oops', 'nope'] as unknown as [number, number] },
    ]);

    const result = await processGeocodeCompany(fakeJob());

    expect(result).toEqual({ status: 'error', reason: 'bad-coordinate' });
    expect(prismaMocks.company.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: {
        geocodingStatus: 'failed',
        geocodingError: 'Mapbox returned a malformed coordinate.',
      },
    });
  });
});
