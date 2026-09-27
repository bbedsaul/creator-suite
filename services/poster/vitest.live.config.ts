import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Live aggregator calls (D-082). Gated behind LIVE_ADAPTER_TESTS=1 inside the
    // suite as well, so running this config without credentials skips rather than
    // fails, and never posts unless LIVE_ADAPTER_PUBLISH=1 too.
    include: ['test/live/**/*.live.test.ts'],
    fileParallelism: false,
    testTimeout: 180_000,
  },
});
