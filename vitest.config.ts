import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The database tests share one PostgreSQL but each file works in its own schema, so files can run in parallel.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
