import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildErrorCsv } from './job-runner.js';
import { putImportSource } from './storage.js';

// buildErrorCsv has to round-trip through storage.ts to read the CSV back —
// the dev fallback in storage.ts is an in-memory cache keyed by S3 key, so
// these tests work without real S3 wiring.

describe('buildErrorCsv', () => {
  const jobId = 'test-error-csv-' + Math.random().toString(36).slice(2, 8);
  let key = '';
  beforeAll(async () => {
    const csv = [
      'Name,Notes',
      // Cell starts with `=` — Excel would otherwise interpret as a formula.
      'Acme,=cmd|"/c calc"!A1',
      // Cell starts with `+` — same family of formula triggers.
      'Bad,+danger',
      'Good,benign',
    ].join('\n');
    key = await putImportSource(jobId, Buffer.from(csv, 'utf-8'));
  });
  afterAll(() => {
    // No teardown for the in-memory dev cache — process scoped, fine.
  });

  it('neutralizes leading formula characters in error rows', async () => {
    const out = await buildErrorCsv(key, [
      { row: 2, column: 'Notes', value: '=cmd', reason: 'fail' },
      { row: 3, column: 'Notes', value: '+danger', reason: 'fail' },
    ]);
    // Body should contain prefixed apostrophes on the offending cells.
    expect(out).toContain(`"'=cmd|""/c calc""!A1"`);
    expect(out).toContain(`"'+danger"`);
    // Good row was not flagged → must not appear.
    expect(out).not.toContain('benign');
  });

  it('also neutralizes formula chars in the error reason column', async () => {
    const out = await buildErrorCsv(key, [
      { row: 2, column: 'Notes', value: 'x', reason: '=ATTACK("a")' },
    ]);
    expect(out).toContain(`"'=ATTACK(""a"")"`);
  });
});
