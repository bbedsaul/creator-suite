/**
 * GET /v1/platforms/constraints — publishes every limit as data (rule 9).
 *
 * This endpoint is the reason no client should ever hard-code a platform rule:
 * the composer, the Clipper and the Trainer all read their limits from here.
 */
import type { FastifyInstance } from 'fastify';
import type { PlatformConstraintsResponse } from '@suite/poster-contract';
import type { RateLimiter } from '@suite/server-core';
import { enforceAppLimit } from '../plugins/rate-limit.js';
import type { PlatformConstraintStore } from '../../db/platform-constraints.js';

export interface PlatformRouteDeps {
  readonly constraints: PlatformConstraintStore;
  readonly rateLimiter: RateLimiter;
}

export function registerPlatformRoutes(app: FastifyInstance, deps: PlatformRouteDeps): void {
  app.get('/v1/platforms/constraints', async (request): Promise<PlatformConstraintsResponse> => {
    const auth = await app.authenticate(request);
    enforceAppLimit(deps.rateLimiter, request, auth.app);

    return { platforms: await deps.constraints.listEnabled() };
  });
}
