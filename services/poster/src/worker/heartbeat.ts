import type { ShutdownLogger } from '../shutdown.js';

export interface HeartbeatOptions {
  readonly logger: ShutdownLogger;
  readonly intervalMs: number;
  readonly signal: AbortSignal;
}

/**
 * Placeholder for the worker's real loops.
 *
 * S06 replaces this with one dispatch loop per enabled platform (each with its
 * own concurrency and poll interval, so one platform's outage cannot delay
 * another - CLAUDE.md rule 10), S07 adds the reconciler, and S08 the webhook
 * deliverer. What S01 establishes is the shape they all share: a loop that ticks
 * on an interval, logs, and stops promptly when the process is asked to stop.
 *
 * Resolves once `signal` aborts.
 */
export function startHeartbeat({ logger, intervalMs, signal }: HeartbeatOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    let ticks = 0;

    const timer = setInterval(() => {
      ticks += 1;
      logger.info(`heartbeat tick ${String(ticks)}`);
    }, intervalMs);

    const stop = (): void => {
      clearInterval(timer);
      logger.info(`heartbeat stopped after ${String(ticks)} tick(s)`);
      resolve();
    };

    if (signal.aborted) {
      stop();
      return;
    }
    signal.addEventListener('abort', stop, { once: true });
  });
}
