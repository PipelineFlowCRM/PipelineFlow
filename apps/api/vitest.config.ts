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
    env: {
      JOBS_TEST_ENDPOINT_ENABLED: 'true',
    },
  },
});
