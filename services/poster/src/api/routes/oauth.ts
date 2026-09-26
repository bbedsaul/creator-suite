/**
 * POST /v1/oauth/token — client credentials exchange (contract §2.1).
 *
 * Form-encoded per OAuth2. Unknown client, wrong secret, and disabled app all
 * return the same 401 invalid_token: distinguishing them would turn this into an
 * app enumeration oracle.
 */
import type { FastifyInstance } from 'fastify';
import { TokenRequest, type TokenResponse } from '@suite/poster-contract';
import type { AppTokenSigner, RateLimiter } from '@suite/server-core';
import { ApiError } from '../errors.js';
import { enforceTokenEndpointLimit } from '../plugins/rate-limit.js';
import type { ClientAppStore } from '../../db/client-apps.js';

export interface OAuthRouteDeps {
  readonly apps: ClientAppStore;
  readonly appTokens: AppTokenSigner;
  readonly rateLimiter: RateLimiter;
  readonly tokenEndpointLimitPerMin: number;
}

export function registerOAuthRoutes(app: FastifyInstance, deps: OAuthRouteDeps): void {
  app.post('/v1/oauth/token', async (request, reply): Promise<TokenResponse> => {
    const parsed = TokenRequest.safeParse(request.body);
    if (!parsed.success) {
      // Do not echo the submitted values: the body contains a client_secret.
      throw ApiError.invalidRequest(
        'Expected form-encoded grant_type=client_credentials with client_id and client_secret',
      );
    }

    const { client_id: clientId, client_secret: clientSecret } = parsed.data;
    enforceTokenEndpointLimit(deps.rateLimiter, request, clientId, deps.tokenEndpointLimitPerMin);

    const authenticated = await deps.apps.authenticate(clientId, clientSecret);
    if (authenticated === undefined) {
      request.log.info({ clientId }, 'token request rejected');
      throw ApiError.invalidToken('Unknown client_id or incorrect client_secret');
    }

    const { token, expiresInSeconds } = await deps.appTokens.sign({
      sub: authenticated.id,
      client_id: authenticated.clientId,
      first_party: authenticated.firstParty,
    });

    // A token is a credential: never cache it anywhere on the way back.
    void reply.header('cache-control', 'no-store');

    return { access_token: token, token_type: 'Bearer', expires_in: expiresInSeconds };
  });
}
