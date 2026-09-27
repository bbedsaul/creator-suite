/**
 * The auth surface against the real world: the real ClientAppStore reading
 * argon2 hashes from Postgres, real Supabase ES256 session tokens verified
 * through the project's JWKS (D-046), the seed script, and the generated
 * @suite/poster-client talking to the service over HTTP.
 *
 * The unit tests in test/api-auth.test.ts fake the database and Supabase so they
 * run anywhere. This file exists because those fakes cannot prove the two things
 * most likely to break in production: that our argon2 verification matches what
 * the seed script wrote, and that we can verify a token Supabase actually issued.
 *
 * Requires a running local stack (`pnpm exec supabase start`).
 */
import { createPosterClient, unwrap } from '@suite/poster-client';
import {
  InMemoryRateLimiter,
  createAppTokenSigner,
  createUserTokenVerifier,
} from '@suite/server-core';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { loadConfig } from '../../src/config.js';
import { createClientAppStore } from '../../src/db/client-apps.js';
import { createPlatformConstraintStore } from '../../src/db/platform-constraints.js';
import { createValidationContextStore } from '../../src/db/validation-context.js';
import { createGrantStore } from '../../src/db/grants.js';
import { createMediaStore } from '../../src/db/media.js';
import { createPostStore } from '../../src/db/posts.js';
import { createStubProber, createStubStorage } from '../helpers/build-test-server.js';
import { M1_DEMO_CLIENT_ID, TEST_CLIENT_ID, TEST_CLIENT_SECRET, seed } from '../../src/seed.js';

const DATABASE_URL =
  process.env['POSTER_TEST_DATABASE_URL'] ??
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const SUPABASE_URL = process.env['POSTER_TEST_SUPABASE_URL'] ?? 'http://127.0.0.1:54321';

/**
 * The standard Supabase local development key, published in their own docs. It is
 * not a secret and only ever reaches a database on this machine.
 */
const SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const APP_TOKEN_SECRET = 'integration-test-signing-secret-32ch';
const APP_TOKEN_ISSUER = 'poster-api';

const USERS = [
  { email: `s03-a-${Date.now()}@example.test`, password: 'integration-password-a1' },
  { email: `s03-b-${Date.now()}@example.test`, password: 'integration-password-b1' },
];

const sql = postgres(DATABASE_URL, { max: 3, onnotice: () => {} });

let app: FastifyInstance | undefined;
let baseUrl = '';
let reachable = false;
let sessions: { id: string; token: string }[] = [];

async function supabase(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Removes only what this suite created. The seeded client_apps are left in place:
 * they are ordinary development fixtures, the pgTAP suites no longer collide with
 * them, and deleting them would quietly undo a developer's `pnpm seed`.
 *
 * The rotation test is scoped to `trainer-dev` (D-101), so running this suite no
 * longer invalidates the other seeded secrets sitting in a developer's .env.local.
 */
async function cleanup(): Promise<void> {
  for (const user of USERS) {
    await sql`delete from auth.users where email = ${user.email}`;
  }
}

beforeAll(async () => {
  try {
    await sql`select 1`;
    const jwks = await fetch(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`);
    if (!jwks.ok) return;
    reachable = true;
  } catch {
    return;
  }

  await cleanup();
  await seed(DATABASE_URL);

  // Real users with real, asymmetrically signed session tokens.
  sessions = [];
  for (const user of USERS) {
    const created = await supabase('/auth/v1/admin/users', { ...user, email_confirm: true });
    const signedIn = await supabase('/auth/v1/token?grant_type=password', user);
    sessions.push({
      id: created['id'] as string,
      token: signedIn['access_token'] as string,
    });
  }

  app = buildServer(
    { ...loadConfig(), logLevel: 'fatal', port: 0 },
    {
      apps: createClientAppStore(sql),
      constraints: createPlatformConstraintStore(sql),
      validationContext: createValidationContextStore(sql),
      grants: createGrantStore(sql),
      mediaStore: createMediaStore(sql),
      postStore: createPostStore(sql),
      // These suites cover auth and constraints; posts and media have their own.
      storage: createStubStorage(),
      prober: createStubProber(),
      maxDirectUploadBytes: 8 * 1024 * 1024,
      signedUrlTtlS: 3600,
      appTokens: createAppTokenSigner({
        secret: APP_TOKEN_SECRET,
        keyId: 'k1',
        issuer: APP_TOKEN_ISSUER,
        audience: APP_TOKEN_ISSUER,
      }),
      userTokens: createUserTokenVerifier({
        jwksUrl: `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
        issuer: `${SUPABASE_URL}/auth/v1`,
      }),
      rateLimiter: new InMemoryRateLimiter(),
      appTokenIssuer: APP_TOKEN_ISSUER,
      firstPartyClientId: 'poster-web',
      tokenEndpointLimitPerMin: 100,
      corsOrigins: ['http://localhost:5173'],
    },
  );

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  baseUrl =
    typeof address === 'object' && address !== null
      ? `http://127.0.0.1:${String(address.port)}`
      : '';
});

afterAll(async () => {
  await app?.close();
  if (reachable) await cleanup();
  await sql.end({ timeout: 5 });
});

/** Exchanges the seeded test-client credentials for a real app token. */
async function appToken(secret = TEST_CLIENT_SECRET): Promise<Response> {
  return fetch(`${baseUrl}/v1/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: TEST_CLIENT_ID,
      client_secret: secret,
    }),
  });
}

describe('environment', () => {
  it('has a reachable database and Supabase auth', () => {
    expect(
      reachable,
      `need a local stack: run \`pnpm exec supabase start\` (db ${DATABASE_URL}, auth ${SUPABASE_URL})`,
    ).toBe(true);
  });
});

describe('the seed script (D-049)', () => {
  it('registers poster-web, trainer-dev, test-client and m1-demo', async () => {
    const rows = await sql<{ client_id: string; first_party: boolean }[]>`
      select client_id, first_party from poster.client_apps order by client_id`;
    // Every seeded app, exactly: an app that appears here without being listed is
    // an app someone can get a token for, so the assertion is a whitelist rather
    // than a `toContain`.
    expect(rows.map((row) => row.client_id)).toEqual([
      M1_DEMO_CLIENT_ID,
      'poster-web',
      TEST_CLIENT_ID,
      'trainer-dev',
    ]);
    expect(rows.find((row) => row.client_id === 'poster-web')?.first_party).toBe(true);
    // Only the composer is first-party (D-023): a third-party app must not be able
    // to act in user mode.
    expect(rows.filter((row) => row.first_party).map((row) => row.client_id)).toEqual([
      'poster-web',
    ]);
  });

  it('stores argon2id hashes, never plaintext secrets', async () => {
    const rows = await sql<{ client_secret_hash: string }[]>`
      select client_secret_hash from poster.client_apps`;
    for (const row of rows) {
      expect(row.client_secret_hash.startsWith('$argon2id$')).toBe(true);
      expect(row.client_secret_hash).not.toContain(TEST_CLIENT_SECRET);
    }
  });

  it('preserves an existing secret when re-run, so .env.local stays valid (D-051)', async () => {
    const before = await sql<{ client_secret_hash: string }[]>`
      select client_secret_hash from poster.client_apps where client_id = 'trainer-dev'`;
    const entries = await seed(DATABASE_URL);
    const after = await sql<{ client_secret_hash: string }[]>`
      select client_secret_hash from poster.client_apps where client_id = 'trainer-dev'`;

    expect(after).toHaveLength(1);
    expect(after[0]?.client_secret_hash).toBe(before[0]?.client_secret_hash);
    // And it says so, rather than pretending it issued something.
    const trainer = entries.find((entry) => entry.clientId === 'trainer-dev');
    expect(trainer?.status).toBe('preserved');
    expect(trainer?.secret).toBeUndefined();
  });

  it('rotates on request, without duplicating the row', async () => {
    const before = await sql<{ client_secret_hash: string }[]>`
      select client_secret_hash from poster.client_apps where client_id = 'trainer-dev'`;
    // Scoped to trainer-dev, which is the only app this test asserts on. An
    // unscoped rotate also invalidates every other generated secret, including the
    // one tools/m1-demo reads from .env.local (D-101).
    const entries = await seed(DATABASE_URL, { rotate: true, only: ['trainer-dev'] });
    const after = await sql<{ client_secret_hash: string }[]>`
      select client_secret_hash from poster.client_apps where client_id = 'trainer-dev'`;

    expect(after).toHaveLength(1);
    expect(after[0]?.client_secret_hash).not.toBe(before[0]?.client_secret_hash);

    const trainer = entries.find((entry) => entry.clientId === 'trainer-dev');
    expect(trainer?.status).toBe('rotated');
    expect(trainer?.secret).toBeTruthy();
  });

  it('keeps the published test-client secret working across runs', async () => {
    await seed(DATABASE_URL);
    const response = await appToken();
    expect(response.status).toBe(200);
  });
});

describe('POST /v1/oauth/token against the real store', () => {
  it('accepts the seeded secret, verifying a hash argon2 actually wrote', async () => {
    const response = await appToken();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { token_type: string; expires_in: number };
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(900);
  });

  it('rejects a wrong secret with the 401 envelope', async () => {
    const response = await appToken('not-the-secret');
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string; request_id: string } };
    expect(body.error.code).toBe('invalid_token');
    expect(body.error.request_id).toBe(response.headers.get('x-request-id'));
  });
});

describe('the generated client (D-026)', () => {
  it('reaches the service in app mode and types the response', async () => {
    const token = ((await (await appToken()).json()) as { access_token: string }).access_token;
    const client = createPosterClient({ baseUrl, getToken: () => token });

    const context = unwrap(await client.GET('/v1/auth/context'));
    expect(context.mode).toBe('app');
    expect(context.app.client_id).toBe(TEST_CLIENT_ID);
    expect(context.user_id).toBeNull();
  });

  it('passes a user_id through in app mode', async () => {
    const token = ((await (await appToken()).json()) as { access_token: string }).access_token;
    const client = createPosterClient({ baseUrl, getToken: () => token });

    const context = unwrap(
      await client.GET('/v1/auth/context', {
        params: { query: { user_id: sessions[0]?.id as string } },
      }),
    );
    expect(context.user_id).toBe(sessions[0]?.id);
  });
});

describe('user mode with a real Supabase session token (D-046)', () => {
  it('verifies an ES256 token through JWKS and acts as poster-web', async () => {
    const client = createPosterClient({ baseUrl, getToken: () => sessions[0]?.token });
    const context = unwrap(await client.GET('/v1/auth/context'));

    expect(context.mode).toBe('user');
    expect(context.app).toEqual({ client_id: 'poster-web', first_party: true });
    expect(context.user_id).toBe(sessions[0]?.id);
  });

  it('rejects a request for another user with 403 forbidden_user', async () => {
    const response = await fetch(`${baseUrl}/v1/auth/context?user_id=${String(sessions[1]?.id)}`, {
      headers: { authorization: `Bearer ${String(sessions[0]?.token)}` },
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('forbidden_user');
  });

  it('rejects a session token whose signature has been tampered with', async () => {
    const token = sessions[0]?.token as string;
    const [header, payload] = token.split('.');
    const forged = `${String(header)}.${String(payload)}.${'A'.repeat(86)}`;

    const response = await fetch(`${baseUrl}/v1/auth/context`, {
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(response.status).toBe(401);
  });

  it('rejects an app token that claims to be a Supabase session', async () => {
    // Our own issuer routes to the app verifier; a Supabase issuer routes to
    // JWKS. Neither will accept a token signed by the wrong party.
    const foreign = createAppTokenSigner({
      secret: APP_TOKEN_SECRET,
      keyId: 'k1',
      issuer: `${SUPABASE_URL}/auth/v1`,
      audience: 'authenticated',
    });
    const { token } = await foreign.sign({
      sub: sessions[0]?.id as string,
      client_id: 'poster-web',
      first_party: true,
    });

    const response = await fetch(`${baseUrl}/v1/auth/context`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(401);
  });
});
