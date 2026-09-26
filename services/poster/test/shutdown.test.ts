import { describe, expect, it, vi } from 'vitest';
import { startHeartbeat } from '../src/worker/heartbeat.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

describe('startHeartbeat', () => {
  it('ticks on the interval and resolves when aborted', async () => {
    vi.useFakeTimers();
    try {
      const logged: string[] = [];
      const logger = { ...silent, info: (msg: string) => logged.push(msg) };
      const controller = new AbortController();

      const done = startHeartbeat({ logger, intervalMs: 1000, signal: controller.signal });
      await vi.advanceTimersByTimeAsync(3000);
      expect(logged.filter((line) => line.startsWith('heartbeat tick'))).toHaveLength(3);

      controller.abort();
      await done;
      expect(logged.at(-1)).toBe('heartbeat stopped after 3 tick(s)');
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves immediately if the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      startHeartbeat({ logger: silent, intervalMs: 1000, signal: controller.signal }),
    ).resolves.toBeUndefined();
  });
});
