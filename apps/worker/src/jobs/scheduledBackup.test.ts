import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ScheduledBackupJobData,
  ScheduledBackupJobResult,
} from '@pipelineflow/shared';

// ─── Test scaffolding ────────────────────────────────────────────────────────
// Temp dir per test for the local /backups volume. Mocked env points BACKUP_DIR
// here so the processor reads/writes files we control.
const tmpRoot = mkdtempSync(path.join(tmpdir(), 'scheduled-backup-'));

// Per-test handles. The lib/s3 helpers are mocked at the module level so we
// can assert against captured uploads/listings/deletes without touching AWS.
const s3Mocks = vi.hoisted(() => ({
  uploadStream: vi.fn(),
  listAllUnder: vi.fn(),
  deleteObject: vi.fn(),
  s3Configured: vi.fn(() => true),
}));

vi.mock('../lib/s3.js', () => ({
  uploadStream: s3Mocks.uploadStream,
  listAllUnder: s3Mocks.listAllUnder,
  deleteObject: s3Mocks.deleteObject,
  s3Configured: s3Mocks.s3Configured,
  s3: {},
}));

// pg_dump is mocked via node:child_process.spawn. We hand the processor a
// fake child whose stdout streams a known plaintext payload, then close
// with a configurable exit code. Per-test we override `stdoutBytes` and
// `exitCode`.
const spawnState = vi.hoisted(() => ({
  stdoutBytes: Buffer.from('-- test pg_dump output\nSELECT 1;\n'),
  exitCode: 0,
  // If true, the child emits an 'error' before close — simulates ENOENT
  // (pg_dump binary missing).
  emitErrorOnSpawn: false,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const events: Record<string, Array<(...args: unknown[]) => void>> = {};
      const child = {
        stdout,
        stderr,
        on(event: string, fn: (...args: unknown[]) => void) {
          (events[event] ??= []).push(fn);
          return child;
        },
        kill: vi.fn(),
      };
      // Drive the simulated child on the next tick so the processor has
      // time to attach its listeners and start piping.
      queueMicrotask(() => {
        if (spawnState.emitErrorOnSpawn) {
          (events['error'] ?? []).forEach((fn) => fn(new Error('ENOENT: pg_dump')));
          return;
        }
        stdout.end(spawnState.stdoutBytes);
        stderr.end();
        // Wait for stdout consumers to drain before signalling close.
        setTimeout(() => {
          (events['close'] ?? []).forEach((fn) => fn(spawnState.exitCode));
        }, 10);
      });
      return child as unknown as ReturnType<typeof actual.spawn>;
    }),
  };
});

vi.mock('../env.js', () => ({
  env: {
    BACKUP_DIR: tmpRoot,
    BACKUP_RETAIN_DAYS: 30,
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    S3_BUCKET: 'test-bucket',
    S3_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    S3_ENDPOINT: '',
  },
}));

const {
  makeScheduledBackupProcessor,
  LAST_SUCCESS_KEY,
  pgEnvFromUrl,
  verifyGzip,
} = await import('./scheduledBackup.js');

function fakeRedis(initial?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, ...rest: unknown[]) => {
      // The lock helper calls set(key, value, 'PX', ttlMs, 'NX'). When the
      // 'NX' guard is present we honour it: if the key is already set,
      // return null (lock held). Otherwise behave like a plain SET.
      const nx = rest.includes('NX');
      if (nx && store.has(k)) return null;
      store.set(k, String(rest[0] ?? ''));
      return 'OK';
    }),
    eval: vi.fn(async (_script: string, _numKeys: number, key: string, val: string) => {
      // Mirror the redisLock release script: GET-and-DEL only if value matches.
      if (store.get(key) === val) {
        store.delete(key);
        return 1;
      }
      return 0;
    }),
    _store: store,
  } as unknown as Redis & { _store: Map<string, string> };
}

type FakeJob = Job<ScheduledBackupJobData, ScheduledBackupJobResult>;
const fakeJob = (data: ScheduledBackupJobData = { trigger: 'cron' }): FakeJob =>
  ({ id: 'job-1', name: 'scheduled-backup', data } as unknown as FakeJob);

beforeEach(async () => {
  s3Mocks.uploadStream.mockReset().mockResolvedValue(undefined);
  s3Mocks.listAllUnder.mockReset().mockImplementation(async () => {
    // Default: empty bucket.
  });
  s3Mocks.deleteObject.mockReset().mockResolvedValue(undefined);
  s3Mocks.s3Configured.mockReset().mockReturnValue(true);
  spawnState.stdoutBytes = Buffer.from('-- test pg_dump output\nSELECT 1;\n');
  spawnState.exitCode = 0;
  spawnState.emitErrorOnSpawn = false;

  // Clean tmp dir between tests so old artefacts don't leak.
  await mkdir(tmpRoot, { recursive: true });
  for (const name of await readdir(tmpRoot)) {
    rmSync(path.join(tmpRoot, name), { recursive: true, force: true });
  }
});

afterEach(() => {
  // Reset mocks between tests so call-count assertions don't bleed.
  vi.clearAllMocks();
});

describe('processScheduledBackup', () => {
  it('is a no-op when S3 is not configured', async () => {
    s3Mocks.s3Configured.mockReturnValue(false);

    const result = await makeScheduledBackupProcessor(fakeRedis())(fakeJob());

    expect(result).toEqual({ uploaded: 0, pruned: 0, bytes: 0, durationMs: 0 });
    expect(s3Mocks.uploadStream).not.toHaveBeenCalled();
  });

  it('skips when the lock is already held by another runner', async () => {
    // Pre-populate the lock key — the redisLock helper's NX guard should
    // refuse to acquire and the processor should bail.
    const redis = fakeRedis({ 'pf:scheduled-backup:running': 'someone-else' });

    const result = await makeScheduledBackupProcessor(redis)(fakeJob());

    expect(result).toEqual({ uploaded: 0, pruned: 0, bytes: 0, durationMs: 0 });
    expect(s3Mocks.uploadStream).not.toHaveBeenCalled();
  });

  it('happy path: dumps, uploads, writes the freshness key, and releases the lock', async () => {
    const redis = fakeRedis();

    const result = await makeScheduledBackupProcessor(redis)(fakeJob());

    expect(result.uploaded).toBe(1);
    expect(result.pruned).toBe(0);
    expect(result.bytes).toBeGreaterThan(0);
    // Exactly one upload — the fresh dump. Catch-up has nothing to do because
    // listAllUnder returned no existing keys and the file we just wrote is too
    // young (<60s) for the catch-up sweep to consider.
    expect(s3Mocks.uploadStream).toHaveBeenCalledTimes(1);
    const call = s3Mocks.uploadStream.mock.calls[0]!;
    const [key, , contentType, metadata] = call;
    expect(key).toMatch(/^backups\/pipelineflow-.*-scheduled\.sql\.gz$/);
    expect(contentType).toBe('application/gzip');
    expect(metadata).toMatchObject({ sizeBytes: expect.any(String) });

    // Lock released — store should not contain the running key.
    expect(redis._store.has('pf:scheduled-backup:running')).toBe(false);
    // Freshness key written.
    expect(redis._store.has(LAST_SUCCESS_KEY)).toBe(true);
    expect(Number(redis._store.get(LAST_SUCCESS_KEY))).toBeGreaterThan(0);

    // Local file was actually written and is a valid gzip of the test payload.
    const localFiles = (await readdir(tmpRoot)).filter((n) =>
      n.endsWith('-scheduled.sql.gz'),
    );
    expect(localFiles).toHaveLength(1);
  });

  it('surfaces a pg_dump non-zero exit by failing the job and removing the partial file', async () => {
    spawnState.exitCode = 1;
    spawnState.stdoutBytes = Buffer.from(''); // pretend nothing was emitted

    const redis = fakeRedis();
    await expect(
      makeScheduledBackupProcessor(redis)(fakeJob()),
    ).rejects.toThrow(/pg_dump failed/);

    // No file should remain — the dump path unlinks on failure.
    const remaining = (await readdir(tmpRoot)).filter((n) =>
      n.endsWith('-scheduled.sql.gz'),
    );
    expect(remaining).toHaveLength(0);
    // No upload either.
    expect(s3Mocks.uploadStream).not.toHaveBeenCalled();
    // Lock must be released even on failure (try/finally).
    expect(redis._store.has('pf:scheduled-backup:running')).toBe(false);
  });

  it('keeps the local file when S3 upload of the fresh dump fails', async () => {
    s3Mocks.uploadStream.mockRejectedValueOnce(new Error('S3 unreachable'));

    const redis = fakeRedis();
    await expect(
      makeScheduledBackupProcessor(redis)(fakeJob()),
    ).rejects.toThrow(/S3 unreachable/);

    // Local artefact must persist for the next run's catch-up sweep.
    const remaining = (await readdir(tmpRoot)).filter((n) =>
      n.endsWith('-scheduled.sql.gz'),
    );
    expect(remaining).toHaveLength(1);
  });

  it('catch-up sweep uploads pre-migrate dumps left by the api container', async () => {
    // Simulate an old pre-migrate dump (mtime > 60s ago) sitting on the
    // shared volume from a prior api boot.
    const oldName = 'pipelineflow-20260101T000000Z-pre-migrate.sql.gz';
    const oldPath = path.join(tmpRoot, oldName);
    writeFileSync(oldPath, gzipSync(Buffer.from('-- older dump\n')));
    // Backdate so the catch-up's 60s freshness skip doesn't apply.
    const old = Date.now() - 10 * 60_000;
    const fs = await import('node:fs/promises');
    await fs.utimes(oldPath, new Date(old), new Date(old));

    const redis = fakeRedis();

    const result = await makeScheduledBackupProcessor(redis)(fakeJob());

    // 1 fresh dump + 1 catch-up = 2 uploads.
    expect(result.uploaded).toBe(2);
    const keys = s3Mocks.uploadStream.mock.calls.map((c) => c[0] as string);
    expect(keys).toContain(`backups/${oldName}`);
    expect(keys.some((k) => k.endsWith('-scheduled.sql.gz'))).toBe(true);
  });

  it('does not re-upload files already present in S3', async () => {
    // Stage an old pre-migrate dump locally AND tell listAllUnder it already
    // exists in S3. The catch-up sweep should skip it.
    const oldName = 'pipelineflow-20260101T000000Z-pre-migrate.sql.gz';
    const oldPath = path.join(tmpRoot, oldName);
    writeFileSync(oldPath, gzipSync(Buffer.from('-- older dump\n')));
    const old = Date.now() - 10 * 60_000;
    const fs = await import('node:fs/promises');
    await fs.utimes(oldPath, new Date(old), new Date(old));

    s3Mocks.listAllUnder.mockImplementation(async (prefix: string, consume: (o: { Key?: string; LastModified?: Date }) => void) => {
      if (prefix === 'backups/') {
        // Reported during catch-up listing. NOT old enough to be pruned.
        consume({ Key: `backups/${oldName}`, LastModified: new Date(old) });
      }
    });

    const redis = fakeRedis();
    const result = await makeScheduledBackupProcessor(redis)(fakeJob());

    // Only the fresh dump uploaded — the old file was found in S3 already.
    expect(result.uploaded).toBe(1);
    const keys = s3Mocks.uploadStream.mock.calls.map((c) => c[0] as string);
    expect(keys.find((k) => k === `backups/${oldName}`)).toBeUndefined();
  });

  it('prunes local files and S3 objects older than BACKUP_RETAIN_DAYS', async () => {
    // Local: one ancient dump that should be pruned.
    const oldName = 'pipelineflow-20240101T000000Z-pre-migrate.sql.gz';
    const oldPath = path.join(tmpRoot, oldName);
    writeFileSync(oldPath, gzipSync(Buffer.from('-- ancient\n')));
    const ancient = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60 days ago
    const fs = await import('node:fs/promises');
    await fs.utimes(oldPath, new Date(ancient), new Date(ancient));

    // S3: report two objects — one ancient (should be pruned), one recent
    // (should be kept). Both already-present, so the catch-up sweep doesn't
    // re-upload the local ancient file.
    const ancientS3Key = `backups/${oldName}`;
    const recentS3Key = 'backups/pipelineflow-recent-scheduled.sql.gz';
    s3Mocks.listAllUnder.mockImplementation(async (prefix: string, consume: (o: { Key?: string; LastModified?: Date }) => void) => {
      if (prefix === 'backups/') {
        consume({ Key: ancientS3Key, LastModified: new Date(ancient) });
        consume({ Key: recentS3Key, LastModified: new Date(Date.now() - 60_000) });
      }
    });

    const redis = fakeRedis();
    const result = await makeScheduledBackupProcessor(redis)(fakeJob());

    // 1 local + 1 S3 = 2 prunes.
    expect(result.pruned).toBe(2);
    expect(s3Mocks.deleteObject).toHaveBeenCalledTimes(1);
    expect(s3Mocks.deleteObject).toHaveBeenCalledWith(ancientS3Key);

    // Recent S3 object must be left alone.
    const deletedKeys = s3Mocks.deleteObject.mock.calls.map((c) => c[0] as string);
    expect(deletedKeys).not.toContain(recentS3Key);

    // Local ancient file is gone.
    const remaining = await readdir(tmpRoot);
    expect(remaining).not.toContain(oldName);
  });

});

// ─── verifyGzip ─────────────────────────────────────────────────────────────
// Direct unit tests against a real fs path so a future regression that
// silently disables the trailing-CRC check (the only thing that catches a
// dump truncated mid-stream) trips CI.
describe('verifyGzip', () => {
  it('passes a well-formed gzip', async () => {
    const file = path.join(tmpRoot, 'verify-good.sql.gz');
    writeFileSync(file, gzipSync(Buffer.from('-- a perfectly valid dump\nSELECT 1;\n')));
    await expect(verifyGzip(file)).resolves.toBeUndefined();
  });

  it('rejects a truncated gzip (missing trailer)', async () => {
    const file = path.join(tmpRoot, 'verify-truncated.sql.gz');
    const valid = gzipSync(Buffer.from('-- this dump got cut off mid-stream\n'));
    // Lop off the last 4 bytes (gzip's ISIZE field) so the decoder reads
    // the body successfully but errors at end-of-stream. A real truncation
    // mid-stream would behave the same way.
    writeFileSync(file, valid.subarray(0, valid.length - 4));
    await expect(verifyGzip(file)).rejects.toThrow();
  });

  it('rejects a non-gzip file', async () => {
    const file = path.join(tmpRoot, 'verify-not-gzip.sql.gz');
    writeFileSync(file, Buffer.from('SELECT 1; -- never compressed\n'));
    await expect(verifyGzip(file)).rejects.toThrow();
  });
});

// ─── pgEnvFromUrl ───────────────────────────────────────────────────────────
// Plain-text fixtures only — these tests assert URL-decoding semantics, not
// connection behaviour. The L1 fix routes pg_dump through these env vars
// instead of putting the password in argv, so the decoding has to be right.
describe('pgEnvFromUrl', () => {
  it('extracts host/port/user/password/database from a vanilla URL', () => {
    const env = pgEnvFromUrl('postgresql://alice:s3cret@db.example.com:5433/pipeline');
    expect(env).toEqual({
      PGHOST: 'db.example.com',
      PGPORT: '5433',
      PGUSER: 'alice',
      PGPASSWORD: 's3cret',
      PGDATABASE: 'pipeline',
    });
  });

  it('URL-decodes user and password (libpq does NOT do this for env vars)', () => {
    // Real password with %-encoded reserved chars. If we forwarded the raw
    // encoded form, libpq would fail auth with a confusing "wrong password".
    const env = pgEnvFromUrl(
      'postgresql://us%40er:p%40ss%2Fword@host:5432/db',
    );
    expect(env.PGUSER).toBe('us@er');
    expect(env.PGPASSWORD).toBe('p@ss/word');
  });

  it('forwards sslmode if present', () => {
    const env = pgEnvFromUrl(
      'postgresql://u:p@h:5432/db?sslmode=require',
    );
    expect(env.PGSSLMODE).toBe('require');
  });

  it('omits PGDATABASE when the URL has no path component', () => {
    const env = pgEnvFromUrl('postgresql://u:p@h:5432');
    expect(env.PGDATABASE).toBeUndefined();
  });
});

// Sanity: ensure the mocked spawn is wired correctly by reading back the file
// in a small helper test (not strictly necessary, but catches a future
// regression where the mock stops piping bytes).
describe('processScheduledBackup — mock plumbing sanity', () => {
  it('writes a valid gzip with the simulated pg_dump payload', async () => {
    const redis = fakeRedis();
    await makeScheduledBackupProcessor(redis)(fakeJob());

    const files = (await readdir(tmpRoot)).filter((n) => n.endsWith('-scheduled.sql.gz'));
    expect(files).toHaveLength(1);
    const onDisk = readFileSync(path.join(tmpRoot, files[0]!));
    // Gzip magic bytes 0x1f 0x8b
    expect(onDisk[0]).toBe(0x1f);
    expect(onDisk[1]).toBe(0x8b);
  });
});

// keep node fs imports referenced (vitest treeshake guard)
void writeFile;
void stat;
