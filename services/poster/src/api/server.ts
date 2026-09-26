import Fastify, { type FastifyInstance } from 'fastify';
import type { ServiceConfig } from '../config.js';

export const SERVICE_NAME = 'poster-api';

export interface HealthResponse {
  status: 'ok';
  service: typeof SERVICE_NAME;
  /** Seconds this process has been up, rounded down. */
  uptime_s: number;
}

/**
 * Builds the API instance without listening, so tests can drive it through
 * `inject()` and the entrypoint owns the socket and signal handling.
 *
 * The /v1 routes from the internal API contract land in S03 onward. S01 exposes
 * only the liveness probe.
 */
export function buildServer(config: ServiceConfig): FastifyInstance {
  const app = Fastify({
    logger: { level: config.logLevel, name: SERVICE_NAME },
    // Trust the platform proxy for client IPs; the per-app rate limiter in S03
    // depends on getting these right.
    trustProxy: true,
  });

  /**
   * Liveness only: it answers "is this process serving HTTP". It deliberately
   * does not check Postgres or the aggregator, so a dependency outage does not
   * make the platform kill healthy containers. Readiness with dependency checks
   * is a separate endpoint when there are dependencies to check.
   */
  app.get('/healthz', (): HealthResponse => {
    return {
      status: 'ok',
      service: SERVICE_NAME,
      uptime_s: Math.floor(process.uptime()),
    };
  });

  return app;
}
