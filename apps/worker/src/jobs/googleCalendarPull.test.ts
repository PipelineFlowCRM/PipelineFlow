import { type Job } from 'bullmq';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  GoogleCalendarPullJobData,
  GoogleCalendarPullJobResult,
} from '@pipelineflow/shared';

// Mirrors googleContactsPull.test.ts. The calendar pull additionally builds
// a Calendar client (mocked to return an empty event page) so we can drive
// the job to completion and assert on the wall-clock status reconciliation
// that runs after every pull.

const prismaMocks = vi.hoisted(() => ({
  googleCalendarSync: { findUnique: vi.fn(), update: vi.fn() },
  meeting: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
  },
  $transaction: vi.fn(),
}));

const peopleMocks = vi.hoisted(() => ({
  loadGoogleAccount: vi.fn(),
  disableAccount: vi.fn(),
  isInvalidGrant: vi.fn(),
  statusCodeOf: vi.fn(),
  retryAfterMs: vi.fn(() => 60_000),
}));

const calendarMocks = vi.hoisted(() => ({
  buildCalendarHandle: vi.fn(),
}));

const lockMocks = vi.hoisted(() => ({
  acquireLock: vi.fn(),
}));

vi.mock('../db.js', () => ({ prisma: prismaMocks }));
vi.mock('../queue.js', () => ({ redisConnection: {} }));
vi.mock('../lib/redisLock.js', () => ({ acquireLock: lockMocks.acquireLock }));
vi.mock('../integrations/google/calendarClient.js', () => ({
  buildCalendarHandle: calendarMocks.buildCalendarHandle,
}));
vi.mock('../integrations/google/peopleClient.js', async () => {
  const actual = await vi.importActual<object>(
    '../integrations/google/peopleClient.js',
  );
  return {
    ...actual,
    loadGoogleAccount: peopleMocks.loadGoogleAccount,
    disableAccount: peopleMocks.disableAccount,
    isInvalidGrant: peopleMocks.isInvalidGrant,
    statusCodeOf: peopleMocks.statusCodeOf,
    retryAfterMs: peopleMocks.retryAfterMs,
  };
});

const { processGoogleCalendarPull } = await import('./googleCalendarPull.js');

type FakeJob = Job<GoogleCalendarPullJobData, GoogleCalendarPullJobResult>;
const fakeJob = (data: GoogleCalendarPullJobData): FakeJob =>
  ({
    id: 'job-1',
    name: 'google-calendar-pull',
    data,
    token: 'tkn',
    moveToDelayed: vi.fn(),
  } as unknown as FakeJob);

const baseAccount = {
  id: 1,
  userId: 1,
  disabledAt: null,
  disabledReason: null,
  googleEmail: 'rep@acme.com',
  encryptedRefreshToken: 'v1:x:y:z',
};

// A Calendar handle whose events.list returns a single empty page — i.e. the
// delta pull found nothing new, which is exactly the case where a just-ended
// meeting would otherwise stay stuck at 'scheduled'.
const emptyCalendarHandle = () => ({
  calendar: {
    events: {
      list: vi
        .fn()
        .mockResolvedValue({ data: { items: [], nextSyncToken: 'tok2' } }),
    },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  lockMocks.acquireLock.mockResolvedValue(async () => undefined);
  prismaMocks.meeting.updateMany.mockResolvedValue({ count: 0 });
  prismaMocks.googleCalendarSync.update.mockResolvedValue({});
});

describe('processGoogleCalendarPull — status reconciliation', () => {
  it('flips past scheduled/in_progress meetings to completed even when the delta is empty', async () => {
    peopleMocks.loadGoogleAccount.mockResolvedValueOnce(baseAccount);
    prismaMocks.googleCalendarSync.findUnique.mockResolvedValueOnce({
      googleAccountId: 1,
      enabled: true,
      eventsSyncToken: 'tok1',
    });
    calendarMocks.buildCalendarHandle.mockResolvedValueOnce(emptyCalendarHandle());
    // First updateMany (→ completed) reports one row flipped.
    prismaMocks.meeting.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const result = await processGoogleCalendarPull(
      fakeJob({ kind: 'incremental', googleAccountId: 1 }),
    );

    expect(result).toEqual({ upserted: 0, skipped: 0, matched: 0 });
    expect(prismaMocks.meeting.updateMany).toHaveBeenCalledTimes(2);

    const completedCall = prismaMocks.meeting.updateMany.mock.calls[0]![0];
    expect(completedCall.where.sourceAccountId).toBe(1);
    expect(completedCall.where.status).toEqual({ in: ['scheduled', 'in_progress'] });
    expect(completedCall.where.scheduledEnd).toHaveProperty('lte');
    expect(completedCall.where.deletedAt).toBeNull();
    expect(completedCall.data).toEqual({ status: 'completed' });

    const inProgressCall = prismaMocks.meeting.updateMany.mock.calls[1]![0];
    expect(inProgressCall.where.status).toBe('scheduled');
    expect(inProgressCall.where.scheduledStart).toHaveProperty('lte');
    expect(inProgressCall.where.scheduledEnd).toHaveProperty('gt');
    expect(inProgressCall.where.deletedAt).toBeNull();
    expect(inProgressCall.data).toEqual({ status: 'in_progress' });
  });

  it('does not reconcile when calendar sync is disabled', async () => {
    peopleMocks.loadGoogleAccount.mockResolvedValueOnce(baseAccount);
    prismaMocks.googleCalendarSync.findUnique.mockResolvedValueOnce({
      googleAccountId: 1,
      enabled: false,
      eventsSyncToken: null,
    });

    await processGoogleCalendarPull(
      fakeJob({ kind: 'incremental', googleAccountId: 1 }),
    );

    expect(calendarMocks.buildCalendarHandle).not.toHaveBeenCalled();
    expect(prismaMocks.meeting.updateMany).not.toHaveBeenCalled();
  });
});
