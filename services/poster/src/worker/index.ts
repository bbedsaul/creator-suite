/**
 * Worker entrypoint: the long-running process that will host the per-platform
 * dispatch loops, the webhook deliverer, the reconciler, and the sweepers.
 * Deployed as its own container alongside the API (D-022).
 */
import pino from 'pino';
import { loadConfig } from '../config.js';
import { installShutdownHandlers } from '../shutdown.js';
import { startHeartbeat } from './heartbeat.js';

const config = loadConfig();
const logger = pino({ level: config.logLevel, name: 'poster-worker' });
const stopping = new AbortController();

logger.info(`poster-worker starting (${config.nodeEnv}), tick ${String(config.workerTickMs)}ms`);

const running = startHeartbeat({
  logger,
  intervalMs: config.workerTickMs,
  signal: stopping.signal,
});

installShutdownHandlers({
  logger,
  timeoutMs: config.shutdownTimeoutMs,
  hook: async () => {
    stopping.abort();
    await running;
  },
});

await running;
logger.info('poster-worker stopped');
