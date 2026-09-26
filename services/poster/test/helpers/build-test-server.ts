/**
 * Builds a real server with fake outside-world dependencies.
 *
 * Everything under test here is our own code: routing, the envelope, the auth
 * modes, the limiter. The database and Supabase are faked so these stay unit
 * tests that run on a clean clone with nothing installed. The real
 * ClientAppStore and real Supabase JWKS verification are covered by
 * test/integration/auth-api.test.ts.
 */
import type { FastifyInstance } from 'fastify';
import {
  InMemoryRateLimiter,
  TokenInvalidError,
  createAppTokenSigner,
  hashSecret,
  verifySecret,
  type AppTokenSigner,
  type RateLimiter,
  type UserTokenVerifier,
} from '@suite/server-core';
import { loadConfig } from '../../src/config.js';
import { buildServer, type ServerDeps } from '../../src/api/server.js';
import type { ClientApp, ClientAppStore } from '../../src/db/client-apps.js';

export const APP_TOKEN_SECRET = 'a-test-signing-secret-at-least-32-chars';
export const APP_TOKEN_ISSUER = 'poster-api';

export const FIRST_PARTY: ClientApp = {
  id: '11111111-1111-1111-1111-111111111111',
  clientId: 'poster-web',
  name: 'Poster Composer',
  firstParty: true,
  rateLimitPerMin: 600,
};

export const THIRD_PARTY: ClientApp = {
  id: '22222222-2222-2222-2222-222222222222',
  clientId: 'trainer-dev',
  name: 'Trainer (development)',
  firstParty: false,
  rateLimitPerMin: 600,
};

export const GOOD_SECRET = 'correct-client-secret';

export type FakeStore = ClientAppStore & { setLimit(clientId: string, limit: number): void };

/**
 * In-memory store that still hashes and verifies with real argon2, so the 401
 * paths behave exactly as they will in production.
 */
export async function createFakeStore(
  options: { disabled?: Set<string> } = {},
): Promise<FakeStore> {
  const apps = new Map<string, ClientApp>([
    [FIRST_PARTY.clientId, { ...FIRST_PARTY }],
    [THIRD_PARTY.clientId, { ...THIRD_PARTY }],
  ]);
  const hashes = new Map<string, string>([
    [FIRST_PARTY.clientId, await hashSecret(GOOD_SECRET)],
    [THIRD_PARTY.clientId, await hashSecret(GOOD_SECRET)],
  ]);
  const disabled = options.disabled ?? new Set<string>();

  const live = (app: ClientApp | undefined): ClientApp | undefined =>
    app === undefined || disabled.has(app.clientId) ? undefined : app;

  return {
    async authenticate(clientId, secret) {
      const app = apps.get(clientId);
      const hash = hashes.get(clientId);
      if (app === undefined || hash === undefined) {
        // Same work as a real miss, so timing does not enumerate client ids.
        await verifySecret(await hashSecret('decoy'), secret);
        return undefined;
      }
      if (disabled.has(clientId)) return undefined;
      return (await verifySecret(hash, secret)) ? app : undefined;
    },
    findById(appId) {
      return Promise.resolve(live([...apps.values()].find((app) => app.id === appId)));
    },
    findByClientId(clientId) {
      return Promise.resolve(live(apps.get(clientId)));
    },
    setLimit(clientId, limit) {
      const app = apps.get(clientId);
      if (app !== undefined) apps.set(clientId, { ...app, rateLimitPerMin: limit });
    },
  };
}

/** Stands in for Supabase: accepts exactly the tokens it was told about. */
export function createFakeUserTokens(tokens: Record<string, string>): UserTokenVerifier {
  return {
    verify(token) {
      const sub = tokens[token];
      if (sub === undefined) return Promise.reject(new TokenInvalidError('unknown session token'));
      return Promise.resolve({ sub });
    },
  };
}

export interface TestServer {
  app: FastifyInstance;
  store: FakeStore;
  appTokens: AppTokenSigner;
  limiter: RateLimiter;
  advanceClock(ms: number): void;
}

export async function buildTestServer(
  overrides: Partial<ServerDeps> & {
    userTokens?: UserTokenVerifier;
    disabled?: Set<string>;
  } = {},
): Promise<TestServer> {
  const store = await createFakeStore(
    overrides.disabled === undefined ? {} : { disabled: overrides.disabled },
  );
  const appTokens = createAppTokenSigner({
    secret: APP_TOKEN_SECRET,
    keyId: 'k1',
    issuer: APP_TOKEN_ISSUER,
    audience: APP_TOKEN_ISSUER,
  });

  let clockMs = 1_700_000_000_000;
  const limiter = new InMemoryRateLimiter({ now: () => clockMs });

  const app = buildServer(
    { ...loadConfig(), logLevel: 'fatal' },
    {
      apps: store,
      appTokens,
      userTokens: overrides.userTokens ?? createFakeUserTokens({}),
      rateLimiter: limiter,
      appTokenIssuer: APP_TOKEN_ISSUER,
      firstPartyClientId: FIRST_PARTY.clientId,
      tokenEndpointLimitPerMin: 30,
      corsOrigins: ['http://localhost:5173'],
      ...overrides,
    },
  );

  await app.ready();
  return {
    app,
    store,
    appTokens,
    limiter,
    advanceClock: (ms: number) => {
      clockMs += ms;
    },
  };
}

export function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

export const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' };
