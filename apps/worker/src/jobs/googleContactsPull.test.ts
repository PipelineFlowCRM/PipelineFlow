import { DelayedError, type Job } from 'bullmq';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  GoogleContactsPullJobData,
  GoogleContactsPullJobResult,
} from '@pipelineflow/shared';

// Same mocking strategy as googleContactsPush.test.ts. Pull additionally
// touches the redis-lock module — we mock it to always grant the lock so
// the job runs (skipping it would short-circuit every test).

const prismaMocks = vi.hoisted(() => ({
  googleContactsSync: { findUnique: vi.fn(), update: vi.fn() },
  contact: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
  contactGoogleLink: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  company: { findFirst: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(),
}));

const peopleMocks = vi.hoisted(() => ({
  buildPeopleClient: vi.fn(),
  loadGoogleAccount: vi.fn(),
  disableAccount: vi.fn(),
  isInvalidGrant: vi.fn(),
  statusCodeOf: vi.fn(),
  retryAfterMs: vi.fn(() => 60_000),
}));

const lockMocks = vi.hoisted(() => ({
  acquireLock: vi.fn(),
}));

vi.mock('../db.js', () => ({ prisma: prismaMocks }));
vi.mock('../queue.js', () => ({ redisConnection: {} }));
vi.mock('../lib/redisLock.js', () => ({ acquireLock: lockMocks.acquireLock }));
vi.mock('../integrations/google/peopleClient.js', async () => {
  const actual = await vi.importActual<object>(
    '../integrations/google/peopleClient.js',
  );
  return {
    ...actual,
    buildPeopleClient: peopleMocks.buildPeopleClient,
    loadGoogleAccount: peopleMocks.loadGoogleAccount,
    disableAccount: peopleMocks.disableAccount,
    isInvalidGrant: peopleMocks.isInvalidGrant,
    statusCodeOf: peopleMocks.statusCodeOf,
    retryAfterMs: peopleMocks.retryAfterMs,
  };
});

const { processGoogleContactsPull } = await import('./googleContactsPull.js');

type FakeJob = Job<GoogleContactsPullJobData, GoogleContactsPullJobResult>;
const fakeJob = (data: GoogleContactsPullJobData): FakeJob =>
  ({
    id: 'job-1',
    name: 'google-contacts-pull',
    data,
    token: 'tkn',
    moveToDelayed: vi.fn(),
  } as unknown as FakeJob);

const baseAccount = { id: 1, userId: 1, disabledAt: null, encryptedRefreshToken: 'v1:x:y:z' };

beforeEach(() => {
  vi.clearAllMocks();
  // Always grant the lock by default. Tests that exercise the lock-skip
  // branch override this.
  lockMocks.acquireLock.mockResolvedValue(async () => undefined);
  // tx callback runs the function inline against the same prismaMocks.
  prismaMocks.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prismaMocks));
  peopleMocks.isInvalidGrant.mockImplementation((err: unknown) => {
    return Boolean(err && typeof err === 'object' && (err as { invalid_grant?: boolean }).invalid_grant);
  });
  peopleMocks.statusCodeOf.mockImplementation((err: unknown) => {
    if (err && typeof err === 'object') {
      const e = err as { code?: number };
      return e.code ?? null;
    }
    return null;
  });
});

describe('processGoogleContactsPull — gates', () => {
  it('skips when the lock is held by another run', async () => {
    lockMocks.acquireLock.mockResolvedValueOnce(null);
    const result = await processGoogleContactsPull(
      fakeJob({ kind: 'incremental', googleAccountId: 1 }),
    );
    expect(result.applied).toBe(0);
    expect(peopleMocks.loadGoogleAccount).not.toHaveBeenCalled();
  });

  it('skips when the account is disabled', async () => {
    peopleMocks.loadGoogleAccount.mockResolvedValueOnce({ ...baseAccount, disabledAt: new Date(), disabledReason: 'invalid_grant' });
    const result = await processGoogleContactsPull(
      fakeJob({ kind: 'incremental', googleAccountId: 1 }),
    );
    expect(result.applied).toBe(0);
  });

  it('skips when inboundEnabled is false', async () => {
    peopleMocks.loadGoogleAccount.mockResolvedValueOnce(baseAccount);
    prismaMocks.googleContactsSync.findUnique.mockResolvedValueOnce({
      googleAccountId: 1,
      inboundEnabled: false,
      fullSyncDoneAt: null,
      syncToken: null,
      initialPageToken: null,
    });
    const result = await processGoogleContactsPull(
      fakeJob({ kind: 'incremental', googleAccountId: 1 }),
    );
    expect(result.applied).toBe(0);
  });
});

describe('processGoogleContactsPull — initial happy path', () => {
  it('paginates, upserts each Person, and pins nextSyncToken at the end', async () => {
    peopleMocks.loadGoogleAccount.mockResolvedValueOnce(baseAccount);
    prismaMocks.googleContactsSync.findUnique.mockResolvedValueOnce({
      googleAccountId: 1,
      inboundEnabled: true,
      fullSyncDoneAt: null,
      syncToken: null,
      initialPageToken: null,
    });

    const list = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          connections: [
            {
              resourceName: 'people/c1',
              etag: 'e1',
              names: [{ givenName: 'Alpha', familyName: 'One' }],
              emailAddresses: [{ value: 'alpha@example.com', metadata: { primary: true } }],
            },
            {
              resourceName: 'people/c2',
              etag: 'e2',
              names: [{ givenName: 'Beta', familyName: 'Two' }],
            },
          ],
          nextPageToken: undefined,
          nextSyncToken: 'sync-XYZ',
        },
      });

    peopleMocks.buildPeopleClient.mockResolvedValueOnce({
      client: { people: { connections: { list } } } as never,
      oauth: {} as never,
      account: baseAccount,
    });

    // No existing link → create-new path. No email match → create new
    // PF Contact.
    prismaMocks.contactGoogleLink.findUnique.mockResolvedValue(null);
    prismaMocks.contact.findFirst.mockResolvedValue(null);
    prismaMocks.contact.create
      .mockResolvedValueOnce({ id: 101 })
      .mockResolvedValueOnce({ id: 102 });
    prismaMocks.contactGoogleLink.create.mockResolvedValue(undefined);
    prismaMocks.googleContactsSync.update.mockResolvedValue(undefined);

    const result = await processGoogleContactsPull(
      fakeJob({ kind: 'initial', googleAccountId: 1 }),
    );
    expect(result.applied).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.initialDoneNow).toBe(true);
    // Final update must include the syncToken and clear initialPageToken.
    const finalUpdates = prismaMocks.googleContactsSync.update.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data,
    );
    const last = finalUpdates[finalUpdates.length - 1]!;
    expect(last.syncToken).toBe('sync-XYZ');
    expect(last.initialPageToken).toBeNull();
    expect(last.fullSyncDoneAt).toBeInstanceOf(Date);
  });
});

describe('processGoogleContactsPull — sync-token expiry', () => {
  it('falls back to a full sync on 410', async () => {
    peopleMocks.loadGoogleAccount.mockResolvedValueOnce(baseAccount);
    prismaMocks.googleContactsSync.findUnique.mockResolvedValueOnce({
      googleAccountId: 1,
      inboundEnabled: true,
      fullSyncDoneAt: new Date('2026-01-01'),
      syncToken: 'old-stale',
      initialPageToken: null,
    });

    // First call (with syncToken) → 410. Second call (without) succeeds
    // and returns an empty page so the run finishes.
    const list = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('410'), { code: 410 }))
      .mockResolvedValueOnce({ data: { connections: [], nextSyncToken: 'sync-FRESH' } });

    peopleMocks.buildPeopleClient.mockResolvedValueOnce({
      client: { people: { connections: { list } } } as never,
      oauth: {} as never,
      account: baseAccount,
    });
    prismaMocks.googleContactsSync.update.mockResolvedValue(undefined);

    const result = await processGoogleContactsPull(
      fakeJob({ kind: 'incremental', googleAccountId: 1 }),
    );
    expect(result.applied).toBe(0);
    expect(list).toHaveBeenCalledTimes(2);
    // First call carried the stale token; second carried no syncToken.
    expect(list.mock.calls[0]?.[0]?.syncToken).toBe('old-stale');
    expect(list.mock.calls[1]?.[0]?.syncToken).toBeUndefined();
  });
});

describe('processGoogleContactsPull — 429 Retry-After', () => {
  it('moves the job to delayed with the suggested wait, throws DelayedError', async () => {
    peopleMocks.loadGoogleAccount.mockResolvedValueOnce(baseAccount);
    prismaMocks.googleContactsSync.findUnique.mockResolvedValueOnce({
      googleAccountId: 1,
      inboundEnabled: true,
      fullSyncDoneAt: new Date(),
      syncToken: 'ok',
      initialPageToken: null,
    });
    peopleMocks.retryAfterMs.mockReturnValueOnce(45_000);
    const list = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('429'), { code: 429 }));
    peopleMocks.buildPeopleClient.mockResolvedValueOnce({
      client: { people: { connections: { list } } } as never,
      oauth: {} as never,
      account: baseAccount,
    });

    const job = fakeJob({ kind: 'incremental', googleAccountId: 1 });
    await expect(processGoogleContactsPull(job)).rejects.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledOnce();
  });
});

describe('processGoogleContactsPull — invalid_grant', () => {
  it('disables the account and stops', async () => {
    peopleMocks.loadGoogleAccount.mockResolvedValueOnce(baseAccount);
    prismaMocks.googleContactsSync.findUnique.mockResolvedValueOnce({
      googleAccountId: 1,
      inboundEnabled: true,
      fullSyncDoneAt: new Date(),
      syncToken: 'ok',
      initialPageToken: null,
    });
    const list = vi.fn().mockRejectedValueOnce({ invalid_grant: true });
    peopleMocks.buildPeopleClient.mockResolvedValueOnce({
      client: { people: { connections: { list } } } as never,
      oauth: {} as never,
      account: baseAccount,
    });

    const result = await processGoogleContactsPull(
      fakeJob({ kind: 'incremental', googleAccountId: 1 }),
    );
    expect(result.applied).toBe(0);
    expect(peopleMocks.disableAccount).toHaveBeenCalledWith(1, 'invalid_grant');
  });
});

describe('processGoogleContactsPull — gentler LWW (L7)', () => {
  it('does not erase a PF email when the inbound Google contact has no email', async () => {
    peopleMocks.loadGoogleAccount.mockResolvedValueOnce(baseAccount);
    prismaMocks.googleContactsSync.findUnique.mockResolvedValueOnce({
      googleAccountId: 1,
      inboundEnabled: true,
      fullSyncDoneAt: new Date(),
      syncToken: 'ok',
      initialPageToken: null,
    });

    const list = vi.fn().mockResolvedValueOnce({
      data: {
        connections: [
          {
            resourceName: 'people/c1',
            etag: 'e1',
            names: [{ givenName: 'Jane', familyName: 'Doe' }],
            // No emailAddresses — Google has no email
            metadata: { sources: [{ updateTime: new Date().toISOString() }] },
          },
        ],
        nextSyncToken: 'sync-N',
      },
    });
    peopleMocks.buildPeopleClient.mockResolvedValueOnce({
      client: { people: { connections: { list } } } as never,
      oauth: {} as never,
      account: baseAccount,
    });

    // Existing link → existing-update path (last-write-wins).
    prismaMocks.contactGoogleLink.findUnique.mockResolvedValueOnce({
      id: 1,
      contactId: 100,
      resourceName: 'people/c1',
      etag: 'e0',
      lastPushedHash: null,
      lastPulledHash: null,
    });
    // Contact in PF has email "manual@example.com" the user added.
    prismaMocks.contact.findUnique.mockResolvedValueOnce({
      updatedAt: new Date('2020-01-01'),
    });
    prismaMocks.contact.update.mockResolvedValueOnce(undefined);
    prismaMocks.contactGoogleLink.update.mockResolvedValueOnce(undefined);
    prismaMocks.googleContactsSync.update.mockResolvedValue(undefined);

    await processGoogleContactsPull(
      fakeJob({ kind: 'incremental', googleAccountId: 1 }),
    );

    // The contact.update payload must not include a null email. With
    // the gentler LWW we only set fields where Google has a value.
    const updateArg = prismaMocks.contact.update.mock.calls[0]?.[0] as
      | { data: Record<string, unknown> }
      | undefined;
    expect(updateArg).toBeDefined();
    expect('email' in (updateArg?.data ?? {})).toBe(false);
  });
});
