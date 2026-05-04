import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    // Native modules (argon2, prisma) need a real Node runtime; forks
    // isolate them per worker.
    pool: 'forks',
    // Pre-set env vars before any module loads. dotenv won't override
    // existing values, so env.ts sees these even though it's loaded by
    // dotenv/config first.
    //
    // TZ=UTC pins date/timestamp parsing to a deterministic timezone so
    // chrono-based parsers (parsers/date.ts) and any direct Date use
    // round-trip identical results across CI runners. Without this, a
    // test runner in Asia/Tokyo would produce different outputs than
    // one in America/New_York for the same chrono-parsed wall-clock
    // input. Vitest's `forks` pool spawns new worker processes, so the
    // TZ env var takes effect before Date is initialized.
    env: {
      JOBS_TEST_ENDPOINT_ENABLED: 'true',
      TZ: 'UTC',
    },
  },
});
