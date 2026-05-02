import type { Job, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  S3CleanupJobData,
  S3CleanupJobResult,
  S3ReconcileJobData,
  S3ReconcileJobResult,
} from '@pipelineflow/shared';
import { STATE_KEY } from './s3Reconcile.js';

// Mock the AWS SDK so we can script ListObjectsV2 responses per-test. The
// processor calls listAllUnder(prefix) which iterates pages until
// IsTruncated=false; we pre-stack pages with `mocks.send.mockResolvedValueOnce`.
const mocks = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: mocks.send })),
  ListObjectsV2Command: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

vi.mock('../env.js', () => ({
  env: {
    S3_BUCKET: 'test-bucket',
    S3_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    S3_ENDPOINT: '',
  },
}));

// Mock prisma — we control the in-use snapshot per test by changing what
// findMany returns. Each model's findMany defaults to an empty array so
// the "everything is orphaned" case is easy to write.
const prismaMocks = vi.hoisted(() => ({
  attachment: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
  company: { findMany: vi.fn() },
}));

vi.mock('../db.js', () => ({
  prisma: prismaMocks,
}));

const { makeReconcileProcessor } = await import('./s3Reconcile.js');

// Test doubles for the cleanup queue and Redis state. We assert against
// `cleanupAdd` to verify the reconcile correctly enqueued (or didn't)
// for a given input. Redis is in-memory key/value behind a Map so
// loadLastChecked / saveLastChecked round-trip.
function fakeCleanupQueue() {
  const add = vi.fn().mockResolvedValue(undefined);
  return {
    queue: { add } as unknown as Queue<S3CleanupJobData, S3CleanupJobResult>,
    add,
  };
}
function fakeRedis(initial?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    }),
    del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
    _store: store,
  } as unknown as Redis & { _store: Map<string, string> };
}

type FakeJob = Job<S3ReconcileJobData, S3ReconcileJobResult>;
const fakeJob = (data: S3ReconcileJobData = {}): FakeJob =>
  ({ id: 'job-1', name: 's3-reconcile', data } as unknown as FakeJob);

// Helper: build a single-page ListObjectsV2 response.
function listPage(contents: { Key: string; LastModified: Date }[]) {
  return { Contents: contents, IsTruncated: false, NextContinuationToken: undefined };
}

beforeEach(() => {
  mocks.send.mockReset();
  prismaMocks.attachment.findMany.mockResolvedValue([]);
  prismaMocks.user.findMany.mockResolvedValue([]);
  prismaMocks.company.findMany.mockResolvedValue([]);
});

describe('processS3Reconcile', () => {
  // Run the env-overriding test FIRST. It uses vi.resetModules + vi.doMock
  // to swap in an empty bucket config and re-import the processor with that
  // version. Order matters because the module-level `await import` above
  // caches the original-env module — subsequent tests reuse that cached
  // binding, but a future test added BEFORE this one and after the cache
  // reset would inherit the empty-env version. Putting this first keeps
  // the cache invalidation contained.
  it('is a no-op when S3 is not configured', async () => {
    vi.resetModules();
    vi.doMock('../env.js', () => ({
      env: {
        S3_BUCKET: '',
        S3_REGION: 'us-east-1',
        AWS_ACCESS_KEY_ID: '',
        AWS_SECRET_ACCESS_KEY: '',
        S3_ENDPOINT: '',
      },
    }));
    try {
      const { makeReconcileProcessor: makeNoConfig } = await import('./s3Reconcile.js');
      const cleanup = fakeCleanupQueue();
      const result = await makeNoConfig(cleanup.queue, fakeRedis())(fakeJob());

      expect(result).toEqual({ scanned: 0, orphaned: 0 });
      expect(mocks.send).not.toHaveBeenCalled();
    } finally {
      // Always restore the original env mock + clear the doMock'd module
      // cache so subsequent tests in this file get the configured version.
      vi.doUnmock('../env.js');
      vi.resetModules();
    }
  });

  it('runs a full scan when no prior timestamp exists', async () => {
    const old = new Date('2026-01-01T00:00:00Z');
    mocks.send
      .mockResolvedValueOnce(listPage([{ Key: 'attachment/2026-01-01/orphan.pdf', LastModified: old }]))
      .mockResolvedValueOnce(listPage([]))
      .mockResolvedValueOnce(listPage([]));

    const cleanup = fakeCleanupQueue();
    const redis = fakeRedis(); // empty — no STATE_KEY → first run

    const processor = makeReconcileProcessor(cleanup.queue, redis);
    const result = await processor(fakeJob());

    expect(result.scanned).toBe(1);
    expect(result.orphaned).toBe(1);
    // Three LIST calls — one per scope (attachment/, avatar/, logo/) — proving
    // the absence of date-prefix narrowing on first run.
    expect(mocks.send).toHaveBeenCalledTimes(3);
    expect(cleanup.add).toHaveBeenCalledTimes(1);
    expect(cleanup.add).toHaveBeenCalledWith('s3-cleanup', {
      keys: ['attachment/2026-01-01/orphan.pdf'],
    });
    // High-water mark persisted on success.
    expect(redis._store.has(STATE_KEY)).toBe(true);
  });

  it('skips keys that are still in use by the DB', async () => {
    const old = new Date('2026-01-01T00:00:00Z');
    mocks.send
      .mockResolvedValueOnce(
        listPage([
          { Key: 'attachment/2026-01-01/in-use.pdf', LastModified: old },
          { Key: 'attachment/2026-01-01/orphan.pdf', LastModified: old },
        ]),
      )
      .mockResolvedValueOnce(listPage([]))
      .mockResolvedValueOnce(listPage([]));
    prismaMocks.attachment.findMany.mockResolvedValue([
      { storedKey: 'attachment/2026-01-01/in-use.pdf' },
    ]);

    const cleanup = fakeCleanupQueue();
    const result = await makeReconcileProcessor(cleanup.queue, fakeRedis())(fakeJob());

    expect(result.orphaned).toBe(1);
    expect(cleanup.add).toHaveBeenCalledWith('s3-cleanup', {
      keys: ['attachment/2026-01-01/orphan.pdf'],
    });
  });

  it('skips keys inside the 24h grace window (still might be registering)', async () => {
    const fresh = new Date(Date.now() - 60 * 60 * 1000); // 1h ago — within grace
    mocks.send
      .mockResolvedValueOnce(
        listPage([{ Key: 'attachment/today/fresh.pdf', LastModified: fresh }]),
      )
      .mockResolvedValueOnce(listPage([]))
      .mockResolvedValueOnce(listPage([]));

    const cleanup = fakeCleanupQueue();
    const result = await makeReconcileProcessor(cleanup.queue, fakeRedis())(fakeJob());

    expect(result.scanned).toBe(1);
    expect(result.orphaned).toBe(0);
    expect(cleanup.add).not.toHaveBeenCalled();
  });

  it('runs incremental when a prior timestamp exists, narrowing to date prefixes', async () => {
    // Prior reconcile happened 2 days ago; today is 2026-05-02. Window =
    // [last - grace, today] → ~3 calendar dates × 3 scopes = 9 LIST calls.
    const lastMs = new Date('2026-05-01T00:00:00Z').getTime();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-02T12:00:00Z'));
    try {
      // Every page returns empty — we're only counting LIST calls + verifying
      // the prefixes the processor asks for.
      mocks.send.mockResolvedValue(listPage([]));

      const redis = fakeRedis({ [STATE_KEY]: String(lastMs) });
      const cleanup = fakeCleanupQueue();
      await makeReconcileProcessor(cleanup.queue, redis)(fakeJob());

      // window = [2026-04-30, 2026-05-02] = 3 dates × 3 scopes = 9 calls
      expect(mocks.send).toHaveBeenCalledTimes(9);
      // Every call must carry a date-narrowed prefix, not a bare scope.
      const prefixes = mocks.send.mock.calls.map(
        (c) => (c[0] as { input: { Prefix: string } }).input.Prefix,
      );
      for (const p of prefixes) {
        expect(p).toMatch(/^(attachment|avatar|logo)\/\d{4}-\d{2}-\d{2}\/$/);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('forceFull bypasses the prior timestamp and runs a full scan', async () => {
    const lastMs = new Date('2026-05-01T00:00:00Z').getTime();
    mocks.send.mockResolvedValue(listPage([]));

    const redis = fakeRedis({ [STATE_KEY]: String(lastMs) });
    const cleanup = fakeCleanupQueue();
    await makeReconcileProcessor(cleanup.queue, redis)(fakeJob({ forceFull: true }));

    // Three LIST calls — one per scope, no date narrowing — proving the
    // prior timestamp was ignored.
    expect(mocks.send).toHaveBeenCalledTimes(3);
    const prefixes = mocks.send.mock.calls.map(
      (c) => (c[0] as { input: { Prefix: string } }).input.Prefix,
    );
    expect(prefixes).toEqual(['attachment/', 'avatar/', 'logo/']);
  });

});
