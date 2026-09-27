import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests only: `pnpm -r test` must pass on a clean clone with nothing
    // running. Tests that need a live database live in test/integration and run
    // via `pnpm test:integration` (D-039).
    include: ['test/**/*.test.ts'],
    // test/live/** talks to real aggregator accounts and is gated behind
    // LIVE_ADAPTER_TESTS; it runs via `pnpm test:live` (D-082).
    exclude: ['test/integration/**', 'test/live/**'],
  },
});
