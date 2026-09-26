/**
 * The two auth modes, on one code path (D-023, contract §2).
 *
 * App mode:  a client-credentials JWT we issued. `user_id` comes from the
 *            request, and app credentials alone never authorize publishing —
 *            the grant check belongs to the routes that act on a user (S05).
 * User mode: the caller's Supabase session JWT. The request acts as the
 *            first-party `poster-web` app, and any `user_id` in the request must
 *            equal the token subject, else 403 forbidden_user.
 *
 * Both produce the same `request.auth`, which is the point: a handler cannot
 * tell the modes apart, so the composer can never drift from what external
 * clients get.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { TokenInvalidError, type AppTokenSigner, type UserTokenVerifier } from '@suite/server-core';
import type { AuthMode } from '@suite/poster-contract';
import { ApiError } from '../errors.js';
import type { ClientApp, ClientAppStore } from '../../db/client-apps.js';

export interface ResolvedAuth {
  readonly mode: AuthMode;
  readonly app: ClientApp;
  /** The user this request acts for, or null when the route is not user-scoped. */
  readonly userId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `authenticate`; absent on unauthenticated routes. */
    auth?: ResolvedAuth;
  }
}

export interface AuthDeps {
  readonly appTokens: AppTokenSigner;
  readonly userTokens: UserTokenVerifier;
  readonly apps: ClientAppStore;
  /** client_id of the first-party app user-mode requests act as. */
  readonly firstPartyClientId: string;
  /** Issuer of our own app tokens, used to route a token to the right verifier. */
  readonly appTokenIssuer: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (header === undefined) throw ApiError.invalidToken('Authorization header is missing');
  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || value === undefined || value === '') {
    throw ApiError.invalidToken('Authorization header must be "Bearer <token>"');
  }
  return value;
}

/**
 * Reads the unverified `iss` claim purely to choose a verifier. Nothing is
 * trusted from it: each verifier pins its own expected issuer, so a forged
 * `iss` only picks the verifier that will reject it.
 */
function unverifiedIssuer(token: string): string | undefined {
  const segment = token.split('.')[1];
  if (segment === undefined) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as {
      iss?: unknown;
    };
    return typeof payload.iss === 'string' ? payload.iss : undefined;
  } catch {
    return undefined;
  }
}

/** `user_id` may arrive in the query string or the body, depending on the route. */
function requestedUserId(request: FastifyRequest): string | undefined {
  const fromQuery = (request.query as { user_id?: unknown } | undefined)?.user_id;
  if (typeof fromQuery === 'string' && fromQuery !== '') return fromQuery;
  const fromBody = (request.body as { user_id?: unknown } | undefined)?.user_id;
  if (typeof fromBody === 'string' && fromBody !== '') return fromBody;
  return undefined;
}

export function registerAuth(app: FastifyInstance, deps: AuthDeps): void {
  app.decorateRequest('auth', undefined);

  /**
   * Call from a route's preHandler to require authentication. Not a global hook:
   * /healthz and the token endpoint are deliberately unauthenticated, and making
   * that explicit per route beats maintaining an exclusion list.
   */
  app.decorate('authenticate', async (request: FastifyRequest): Promise<ResolvedAuth> => {
    const token = bearerToken(request);
    const issuer = unverifiedIssuer(token);
    const requested = requestedUserId(request);

    if (requested !== undefined && !UUID_RE.test(requested)) {
      throw ApiError.invalidRequest('user_id must be a uuid');
    }

    let resolved: ResolvedAuth;

    if (issuer === deps.appTokenIssuer) {
      let claims;
      try {
        claims = await deps.appTokens.verify(token);
      } catch (cause) {
        if (cause instanceof TokenInvalidError) throw ApiError.invalidToken(cause.message);
        throw cause;
      }
      const actingApp = await deps.apps.findById(claims.sub);
      if (actingApp === undefined) {
        throw ApiError.invalidToken('The app for this token no longer exists or is disabled');
      }
      resolved = { mode: 'app', app: actingApp, userId: requested ?? null };
    } else {
      let subject: string;
      try {
        ({ sub: subject } = await deps.userTokens.verify(token));
      } catch (cause) {
        if (cause instanceof TokenInvalidError) throw ApiError.invalidToken(cause.message);
        throw cause;
      }

      // A user-mode request may not name a different user, even its own app's.
      if (requested !== undefined && requested.toLowerCase() !== subject.toLowerCase()) {
        throw ApiError.forbiddenUser();
      }

      const firstParty = await deps.apps.findByClientId(deps.firstPartyClientId);
      if (firstParty === undefined) {
        // Misconfiguration, not the caller's fault: user mode cannot work at all.
        request.log.error(
          { clientId: deps.firstPartyClientId },
          'first-party app is missing; user mode is unavailable',
        );
        throw new ApiError('internal_error', 'User-mode authentication is unavailable');
      }
      resolved = { mode: 'user', app: firstParty, userId: subject };
    }

    request.auth = resolved;
    return resolved;
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate(request: FastifyRequest): Promise<ResolvedAuth>;
  }
}
