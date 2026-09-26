import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppTokenSigner, RateLimiter, UserTokenVerifier } from '@suite/server-core';
import type { ServiceConfig } from '../config.js';
import type { ClientAppStore } from '../db/client-apps.js';
import type { PlatformConstraintStore } from '../db/platform-constraints.js';
import type { ValidationContextStore } from '../db/validation-context.js';
import type { GrantStore } from '../db/grants.js';
import type { MediaStore } from '../db/media.js';
import type { PostStore } from '../db/posts.js';
import type { MediaProber } from '../media/prober.js';
import type { MediaStorage } from '../media/storage.js';
import { registerAuth } from './plugins/auth.js';
import { registerErrorHandling } from './plugins/errors.js';
import { REQUEST_ID_HEADER, registerRequestId } from './plugins/request-id.js';
import { registerAuthContextRoute } from './routes/auth-context.js';
import { registerOAuthRoutes } from './routes/oauth.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerPlatformRoutes } from './routes/platforms.js';
import { registerPostRoutes } from './routes/posts.js';
import { registerValidateRoute } from './routes/validate.js';

export const SERVICE_NAME = 'poster-api';

export interface HealthResponse {
  status: 'ok';
  service: typeof SERVICE_NAME;
  /** Seconds this process has been up, rounded down. */
  uptime_s: number;
}

/**
 * Everything the API needs from the outside world. Injected rather than
 * constructed here so unit tests can build a real server with fakes and no
 * database, and so the wiring lives in exactly one place (api/index.ts).
 */
export interface ServerDeps {
  readonly apps: ClientAppStore;
  readonly constraints: PlatformConstraintStore;
  readonly validationContext: ValidationContextStore;
  readonly grants: GrantStore;
  readonly mediaStore: MediaStore;
  readonly postStore: PostStore;
  readonly storage: MediaStorage;
  readonly prober: MediaProber;
  readonly maxDirectUploadBytes: number;
  readonly signedUrlTtlS: number;
  readonly appTokens: AppTokenSigner;
  readonly userTokens: UserTokenVerifier;
  readonly rateLimiter: RateLimiter;
  readonly appTokenIssuer: string;
  readonly firstPartyClientId: string;
  readonly tokenEndpointLimitPerMin: number;
  /** Exact origins allowed for user-mode browser calls (contract §2.2). */
  readonly corsOrigins: readonly string[];
}

/**
 * Builds the API instance without listening, so tests drive it through
 * `inject()` and the entrypoint owns the socket and signal handling.
 */
export function buildServer(config: ServiceConfig, deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: { level: config.logLevel, name: SERVICE_NAME },
    // Adopt a caller's correlation id when it sends one; otherwise generate.
    requestIdHeader: REQUEST_ID_HEADER,
    genReqId: () => randomUUID(),
    // The platform proxy supplies client IPs, which the token-endpoint limiter keys on.
    trustProxy: true,
    // Fastify defaults to 100, which makes a mistyped id answer 414 URI Too Long
    // instead of the 404 envelope §8 promises. Our ids are 29 characters, so this
    // is generous; anything beyond it is not a plausible typo.
    maxParamLength: 256,
  });

  registerRequestId(app);
  registerErrorHandling(app);

  // Allow-list, never a wildcard: user mode sends a real session token, so a
  // permissive CORS policy would let any page spend a signed-in user's session.
  void app.register(cors, {
    origin: deps.corsOrigins.length === 0 ? false : [...deps.corsOrigins],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key', REQUEST_ID_HEADER],
    exposedHeaders: [REQUEST_ID_HEADER, 'retry-after'],
  });

  // OAuth2 requires form encoding on the token endpoint.
  void app.register(formbody);

  // Direct media upload. The per-file cap is enforced again at the route so the
  // client gets the contract envelope rather than a plugin error.
  void app.register(multipart, {
    limits: { fileSize: deps.maxDirectUploadBytes, files: 1 },
  });

  registerAuth(app, {
    appTokens: deps.appTokens,
    userTokens: deps.userTokens,
    apps: deps.apps,
    firstPartyClientId: deps.firstPartyClientId,
    appTokenIssuer: deps.appTokenIssuer,
  });

  /**
   * Liveness only: it answers "is this process serving HTTP". It deliberately
   * does not check Postgres or the aggregator, so a dependency outage does not
   * make the platform kill healthy containers (D-035).
   */
  app.get('/healthz', (): HealthResponse => {
    return { status: 'ok', service: SERVICE_NAME, uptime_s: Math.floor(process.uptime()) };
  });

  registerOAuthRoutes(app, {
    apps: deps.apps,
    appTokens: deps.appTokens,
    rateLimiter: deps.rateLimiter,
    tokenEndpointLimitPerMin: deps.tokenEndpointLimitPerMin,
  });

  registerAuthContextRoute(app, { rateLimiter: deps.rateLimiter });

  registerPlatformRoutes(app, {
    constraints: deps.constraints,
    rateLimiter: deps.rateLimiter,
  });

  registerValidateRoute(app, {
    constraints: deps.constraints,
    context: deps.validationContext,
    rateLimiter: deps.rateLimiter,
  });

  registerMediaRoutes(app, {
    media: deps.mediaStore,
    storage: deps.storage,
    prober: deps.prober,
    rateLimiter: deps.rateLimiter,
    maxDirectUploadBytes: deps.maxDirectUploadBytes,
    signedUrlTtlS: deps.signedUrlTtlS,
  });

  registerPostRoutes(app, {
    posts: deps.postStore,
    constraints: deps.constraints,
    context: deps.validationContext,
    grants: deps.grants,
    rateLimiter: deps.rateLimiter,
  });

  return app;
}
