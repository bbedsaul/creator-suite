import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    // Two sessions contending for the same rows: no parallelism across files.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
