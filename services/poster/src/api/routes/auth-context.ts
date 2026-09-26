/**
 * GET /v1/auth/context — report the resolved app and user (contract §2).
 *
 * Added in v1.2 (D-048). It exists because the auth layer's whole promise is
 * that both modes behave identically, and a client otherwise has no way to ask
 * "which app am I, and which user am I acting for?" without attempting real
 * work. It is also the route that makes that promise testable.
 */
import type { FastifyInstance } from 'fastify';
import type { AuthContext } from '@suite/poster-contract';
import type { RateLimiter } from '@suite/server-core';
import { enforceAppLimit } from '../plugins/rate-limit.js';

export interface AuthContextRouteDeps {
  readonly rateLimiter: RateLimiter;
}

export function registerAuthContextRoute(app: FastifyInstance, deps: AuthContextRouteDeps): void {
  app.get('/v1/auth/context', async (request): Promise<AuthContext> => {
    const auth = await app.authenticate(request);
    enforceAppLimit(deps.rateLimiter, request, auth.app);

    return {
      mode: auth.mode,
      app: { client_id: auth.app.clientId, first_party: auth.app.firstParty },
      user_id: auth.userId,
    };
  });
}
