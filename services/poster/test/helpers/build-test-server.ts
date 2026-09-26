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
import {
  encodeId,
  type MediaFacts,
  type PlatformConstraints,
  type PlatformConstraintSpec,
} from '@suite/poster-contract';
import { loadConfig } from '../../src/config.js';
import { buildServer, type ServerDeps } from '../../src/api/server.js';
import type { ClientApp, ClientAppStore } from '../../src/db/client-apps.js';
import type { PlatformConstraintStore } from '../../src/db/platform-constraints.js';
import type {
  ResolvedConnection,
  ValidationContextStore,
} from '../../src/db/validation-context.js';

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

/**
 * Synthetic specs, not the real seeded ones: a unit test asserting on real
 * platform numbers would break every time a platform moved, and the committed
 * specs are covered by poster-contract's own tests and the integration suite.
 */
export const FAKE_SPECS: Record<string, PlatformConstraintSpec> = {
  tiktok: {
    provisional: true,
    text: { max_length: 10, unit: 'utf16_code_units' },
    media: { kinds: ['video'], mime_types: ['video/mp4'], min_count: 1, max_count: 1 },
    video: { max_duration_s: 60, max_duration_is_per_account: true },
    threads: { supported: false },
    sources: [{ url: 'https://example.test/tiktok', retrieved: '2026-09-26' }],
  },
  youtube: {
    provisional: true,
    text: { max_length: 5000, unit: 'utf8_bytes', forbidden_characters: ['<', '>'] },
    title: { max_length: 100, unit: 'characters' },
    media: { kinds: ['video'], mime_types: ['video/mp4'], min_count: 1, max_count: 1 },
    video: { max_duration_s: 43200, max_duration_is_per_account: true },
    threads: { supported: false },
    sources: [{ url: 'https://example.test/youtube', retrieved: '2026-09-26' }],
  },
};

/** Deterministic public ids for the fixtures below. */
export const TIKTOK_CONNECTION = encodeId('connection', '11111111-2222-4333-8444-555555555551');
export const YOUTUBE_CONNECTION = encodeId('connection', '11111111-2222-4333-8444-555555555552');
export const FOREIGN_CONNECTION = encodeId('connection', '99999999-2222-4333-8444-555555555559');
export const VIDEO_MEDIA = encodeId('media', '22222222-3333-4444-8555-666666666661');

export function createFakeConstraintStore(
  specs: Record<string, PlatformConstraintSpec> = FAKE_SPECS,
): PlatformConstraintStore {
  const platforms: PlatformConstraints[] = Object.entries(specs).map(([platformId, spec]) => ({
    platform_id: platformId,
    display_name: platformId,
    supports_threads: spec.threads.supported,
    spec_version: 1,
    updated_at: '2026-09-26T00:00:00.000Z',
    spec,
  }));

  return {
    listEnabled: () => Promise.resolve(platforms),
    specsByPlatform: () => Promise.resolve(new Map(Object.entries(specs))),
  };
}

export function createFakeValidationContext(
  options: {
    connections?: Record<string, string>;
    media?: Record<string, MediaFacts>;
  } = {},
): ValidationContextStore {
  const connections =
    options.connections ??
    ({ [TIKTOK_CONNECTION]: 'tiktok', [YOUTUBE_CONNECTION]: 'youtube' } as Record<string, string>);
  const media =
    options.media ??
    ({
      [VIDEO_MEDIA]: {
        media_id: VIDEO_MEDIA,
        kind: 'video',
        mime_type: 'video/mp4',
        duration_s: 30,
        width: 1080,
        height: 1920,
      },
    } as Record<string, MediaFacts>);

  return {
    resolveConnections(_userId, publicIds) {
      const found = new Map<string, ResolvedConnection>();
      for (const id of publicIds) {
        const platformId = connections[id];
        if (platformId !== undefined) found.set(id, { publicId: id, platformId });
      }
      return Promise.resolve(found);
    },
    resolveMedia(_userId, publicIds) {
      const found = new Map<string, MediaFacts>();
      for (const id of publicIds) {
        const facts = media[id];
        if (facts !== undefined) found.set(id, facts);
      }
      return Promise.resolve(found);
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
      constraints: createFakeConstraintStore(),
      validationContext: createFakeValidationContext(),
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
