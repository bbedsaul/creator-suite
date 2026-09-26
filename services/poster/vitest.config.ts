import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests only: `pnpm -r test` must pass on a clean clone with nothing
    // running. Tests that need a live database live in test/integration and run
    // via `pnpm test:integration` (D-039).
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**'],
  },
});
