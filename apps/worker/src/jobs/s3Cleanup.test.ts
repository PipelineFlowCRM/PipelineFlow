import type { Job } from 'bullmq';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { S3CleanupJobData, S3CleanupJobResult } from '@pipelineflow/shared';

// Mock the AWS SDK at module-load — the processor imports S3Client/DeleteObjectCommand
// at module top, so the mock has to be in place before the processor is imported.
// `vi.hoisted` lets us read out the mock fns inside test bodies for assertions.
const mocks = vi.hoisted(() => {
  return {
    send: vi.fn(),
  };
});

vi.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: vi.fn().mockImplementation(() => ({ send: mocks.send })),
    DeleteObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  };
});

// Stub the env so s3Configured() returns true in tests; otherwise the processor
// short-circuits on every test that's supposed to actually delete keys.
vi.mock('../env.js', () => ({
  env: {
    S3_BUCKET: 'test-bucket',
    S3_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    S3_ENDPOINT: '',
  },
}));

// Import after the mocks so the processor sees the mocked SDK.
const { processS3Cleanup } = await import('./s3Cleanup.js');

type FakeJob = Job<S3CleanupJobData, S3CleanupJobResult>;
const fakeJob = (data: S3CleanupJobData): FakeJob =>
  ({ id: 'job-1', name: 's3-cleanup', data } as unknown as FakeJob);

beforeEach(() => {
  mocks.send.mockReset();
});

describe('processS3Cleanup', () => {
  it('returns deleted: 0 for an empty key list (no S3 calls)', async () => {
    const result = await processS3Cleanup(fakeJob({ keys: [] }));
    expect(result).toEqual({ deleted: 0 });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('issues one DeleteObject per key and counts successes', async () => {
    mocks.send.mockResolvedValue(undefined);
    const result = await processS3Cleanup(
      fakeJob({ keys: ['attachment/a/x.pdf', 'attachment/b/y.png'] }),
    );
    expect(result).toEqual({ deleted: 2 });
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it('lets unexpected S3 errors propagate so BullMQ can retry the job', async () => {
    // Auth/region/bucket errors should NOT be swallowed — surviving keys
    // are no-ops on the next attempt anyway.
    mocks.send
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('AccessDenied'));
    await expect(
      processS3Cleanup(fakeJob({ keys: ['k1', 'k2', 'k3'] })),
    ).rejects.toThrow('AccessDenied');
  });
});
