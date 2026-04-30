import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    // Native modules (argon2, prisma) need a real Node runtime; forks
    // isolate them per worker.
    pool: 'forks',
  },
});
