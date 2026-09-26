/**
 * The auth surface from contract §2 and the error envelope from §8.
 *
 * The rule these tests defend is D-023's promise: both auth modes go through one
 * set of handlers, so the first-party composer cannot drift from what an external
 * client gets. Every failure is also checked for the envelope shape, because a
 * client switching on `error.code` is the whole reason the envelope exists.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ErrorEnvelope } from '@suite/poster-contract';
import {
  FIRST_PARTY,
  FORM_HEADERS,
  GOOD_SECRET,
  THIRD_PARTY,
  buildTestServer,
  createFakeUserTokens,
  formBody,
  type TestServer,
} from './helpers/build-test-server.js';

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SESSION_A = 'supabase-session-token-for-user-a';

let server: TestServer | undefined;

afterEach(async () => {
  await server?.app.close();
  server = undefined;
});

/** Every non-2xx body must parse as the contract envelope. */
function expectEnvelope(body: string, code: string): ErrorEnvelope {
  const parsed = JSON.parse(body) as ErrorEnvelope;
  expect(parsed.error.code).toBe(code);
  expect(parsed.error.message).toBeTruthy();
  expect(parsed.error.request_id, 'every envelope carries a request_id (D-044)').toBeTruthy();
  return parsed;
}

async function mintAppToken(target = THIRD_PARTY): Promise<string> {
  const { token } = await (server as TestServer).appTokens.sign({
    sub: target.id,
    client_id: target.clientId,
    first_party: target.firstParty,
  });
  return token;
}

describe('POST /v1/oauth/token', () => {
  it('exchanges valid credentials for a 15 minute bearer token', async () => {
    server = await buildTestServer();
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/oauth/token',
      headers: FORM_HEADERS,
      payload: formBody({
        grant_type: 'client_credentials',
        client_id: THIRD_PARTY.clientId,
        client_secret: GOOD_SECRET,
      }),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ access_token: string; token_type: string; expires_in: number }>();
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(900);
    expect(body.access_token.split('.')).toHaveLength(3);
  });

  it('never allows a token to be cached', async () => {
    server = await buildTestServer();
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/oauth/token',
      headers: FORM_HEADERS,
      payload: formBody({
        grant_type: 'client_credentials',
        client_id: THIRD_PARTY.clientId,
        client_secret: GOOD_SECRET,
      }),
    });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('rejects a wrong secret with 401 invalid_token', async () => {
    server = await buildTestServer();
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/oauth/token',
      headers: FORM_HEADERS,
      payload: formBody({
        grant_type: 'client_credentials',
        client_id: THIRD_PARTY.clientId,
        client_secret: 'wrong-secret',
      }),
    });

    expect(response.statusCode).toBe(401);
    expectEnvelope(response.body, 'invalid_token');
  });

  it('answers an unknown client_id identically to a wrong secret', async () => {
    server = await buildTestServer();
    const base = {
      method: 'POST' as const,
      url: '/v1/oauth/token',
      headers: FORM_HEADERS,
    };
    const unknown = await server.app.inject({
      ...base,
      payload: formBody({
        grant_type: 'client_credentials',
        client_id: 'no-such-app',
        client_secret: GOOD_SECRET,
      }),
    });
    const wrongSecret = await server.app.inject({
      ...base,
      payload: formBody({
        grant_type: 'client_credentials',
        client_id: THIRD_PARTY.clientId,
        client_secret: 'wrong-secret',
      }),
    });

    // Distinguishing them would turn this endpoint into an app enumeration oracle.
    expect(unknown.statusCode).toBe(wrongSecret.statusCode);
    expect(JSON.parse(unknown.body).error.code).toBe(JSON.parse(wrongSecret.body).error.code);
    expect(JSON.parse(unknown.body).error.message).toBe(JSON.parse(wrongSecret.body).error.message);
  });

  it('rejects a disabled app', async () => {
    server = await buildTestServer({ disabled: new Set([THIRD_PARTY.clientId]) });
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/oauth/token',
      headers: FORM_HEADERS,
      payload: formBody({
        grant_type: 'client_credentials',
        client_id: THIRD_PARTY.clientId,
        client_secret: GOOD_SECRET,
      }),
    });
    expect(response.statusCode).toBe(401);
    expectEnvelope(response.body, 'invalid_token');
  });

  it('rejects an unsupported grant_type with 400 invalid_request', async () => {
    server = await buildTestServer();
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/oauth/token',
      headers: FORM_HEADERS,
      payload: formBody({
        grant_type: 'password',
        client_id: THIRD_PARTY.clientId,
        client_secret: GOOD_SECRET,
      }),
    });
    expect(response.statusCode).toBe(400);
    expectEnvelope(response.body, 'invalid_request');
  });

  it('does not echo the submitted secret in the error message', async () => {
    server = await buildTestServer();
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/oauth/token',
      headers: FORM_HEADERS,
      payload: formBody({ grant_type: 'password', client_secret: 'super-secret-value' }),
    });
    expect(response.body).not.toContain('super-secret-value');
  });
});

describe('token verification on an authenticated route', () => {
  it('rejects a missing Authorization header with 401', async () => {
    server = await buildTestServer();
    const response = await server.app.inject({ method: 'GET', url: '/v1/auth/context' });
    expect(response.statusCode).toBe(401);
    expectEnvelope(response.body, 'invalid_token');
  });

  it.each([
    ['a non-bearer scheme', 'Basic abc123'],
    ['bearer with no value', 'Bearer '],
    ['structural garbage', 'Bearer not.a.jwt'],
    ['an empty token', 'Bearer '],
  ])('rejects %s with 401', async (_label, authorization) => {
    server = await buildTestServer();
    const response = await server.app.inject({
      method: 'GET',
      url: '/v1/auth/context',
      headers: { authorization },
    });
    expect(response.statusCode).toBe(401);
    expectEnvelope(response.body, 'invalid_token');
  });

  it('rejects an expired app token with 401', async () => {
    server = await buildTestServer();
    // Sign with a zero lifetime rather than waiting 15 minutes.
    const { createAppTokenSigner } = await import('@suite/server-core');
    const expiredSigner = createAppTokenSigner({
      secret: 'a-test-signing-secret-at-least-32-chars',
      keyId: 'k1',
      issuer: 'poster-api',
      audience: 'poster-api',
      ttlSeconds: -60,
    });
    const { token } = await expiredSigner.sign({
      sub: THIRD_PARTY.id,
      client_id: THIRD_PARTY.clientId,
      first_party: false,
    });

    const response = await server.app.inject({
      method: 'GET',
      url: '/v1/auth/context',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(401);
    expectEnvelope(response.body, 'invalid_token');
  });

  it('rejects a token for an app that has since been disabled', async () => {
    server = await buildTestServer();
    const token = await mintAppToken();
    // The app disappears after the token was minted; the token must stop working.
    server = await buildTestServer({ disabled: new Set([THIRD_PARTY.clientId]) });
    const response = await server.app.inject({
      method: 'GET',
      url: '/v1/auth/context',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(401);
    expectEnvelope(response.body, 'invalid_token');
  });
});

describe('one route, two auth modes (D-023)', () => {
  it('serves app mode, echoing the requested user_id', async () => {
    server = await buildTestServer();
    const token = await mintAppToken();
    const response = await server.app.inject({
      method: 'GET',
      url: `/v1/auth/context?user_id=${USER_A}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      mode: 'app',
      app: { client_id: THIRD_PARTY.clientId, first_party: false },
      user_id: USER_A,
    });
  });

  it('serves app mode with no user at all', async () => {
    server = await buildTestServer();
    const token = await mintAppToken();
    const response = await server.app.inject({
      method: 'GET',
      url: '/v1/auth/context',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ user_id: string | null }>().user_id).toBeNull();
  });

  it('serves user mode, acting as the first-party app for the token subject', async () => {
    server = await buildTestServer({
      userTokens: createFakeUserTokens({ [SESSION_A]: USER_A }),
    });
    const response = await server.app.inject({
      method: 'GET',
      url: '/v1/auth/context',
      headers: { authorization: `Bearer ${SESSION_A}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      mode: 'user',
      app: { client_id: FIRST_PARTY.clientId, first_party: true },
      user_id: USER_A,
    });
  });

  it('accepts a user-mode request that names its own user_id', async () => {
    server = await buildTestServer({
      userTokens: createFakeUserTokens({ [SESSION_A]: USER_A }),
    });
    const response = await server.app.inject({
      method: 'GET',
      url: `/v1/auth/context?user_id=${USER_A}`,
      headers: { authorization: `Bearer ${SESSION_A}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ user_id: string }>().user_id).toBe(USER_A);
  });

  it('rejects a user-mode request for a different user with 403 forbidden_user', async () => {
    server = await buildTestServer({
      userTokens: createFakeUserTokens({ [SESSION_A]: USER_A }),
    });
    const response = await server.app.inject({
      method: 'GET',
      url: `/v1/auth/context?user_id=${USER_B}`,
      headers: { authorization: `Bearer ${SESSION_A}` },
    });

    expect(response.statusCode).toBe(403);
    expectEnvelope(response.body, 'forbidden_user');
  });

  it('returns the same response shape in both modes', async () => {
    server = await buildTestServer({
      userTokens: createFakeUserTokens({ [SESSION_A]: USER_A }),
    });
    const appToken = await mintAppToken();

    const asApp = await server.app.inject({
      method: 'GET',
      url: `/v1/auth/context?user_id=${USER_A}`,
      headers: { authorization: `Bearer ${appToken}` },
    });
    const asUser = await server.app.inject({
      method: 'GET',
      url: '/v1/auth/context',
      headers: { authorization: `Bearer ${SESSION_A}` },
    });

    expect(asApp.statusCode).toBe(asUser.statusCode);
    expect(Object.keys(asApp.json() as object).sort()).toEqual(
      Object.keys(asUser.json() as object).sort(),
    );
    // Same user, same route, different credential: only the mode and app differ.
    expect(asApp.json<{ user_id: string }>().user_id).toBe(
      asUser.json<{ user_id: string }>().user_id,
    );
  });

  it('rejects a malformed user_id with 400 rather than a 500', async () => {
    server = await buildTestServer();
    const token = await mintAppToken();
    const response = await server.app.inject({
      method: 'GET',
      url: '/v1/auth/context?user_id=not-a-uuid',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(400);
    expectEnvelope(response.body, 'invalid_request');
  });
});

describe('rate limiting (contract §2.1)', () => {
  it('returns 429 with Retry-After once an app exceeds its own limit', async () => {
    server = await buildTestServer();
    server.store.setLimit(THIRD_PARTY.clientId, 5);
    const token = await mintAppToken();
    const request = {
      method: 'GET' as const,
      url: '/v1/auth/context',
      headers: { authorization: `Bearer ${token}` },
    };

    for (let i = 0; i < 5; i += 1) {
      expect((await server.app.inject(request)).statusCode, `request ${String(i)}`).toBe(200);
    }

    const limited = await server.app.inject(request);
    expect(limited.statusCode).toBe(429);
    expectEnvelope(limited.body, 'rate_limited');

    const retryAfter = Number(limited.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
  });

  it('lets the app back in once the bucket refills', async () => {
    server = await buildTestServer();
    server.store.setLimit(THIRD_PARTY.clientId, 60);
    const token = await mintAppToken();
    const request = {
      method: 'GET' as const,
      url: '/v1/auth/context',
      headers: { authorization: `Bearer ${token}` },
    };

    for (let i = 0; i < 60; i += 1) await server.app.inject(request);
    expect((await server.app.inject(request)).statusCode).toBe(429);

    server.advanceClock(1000);
    expect((await server.app.inject(request)).statusCode).toBe(200);
  });

  it('limits the token endpoint too, since it is the brute-force surface', async () => {
    server = await buildTestServer({ tokenEndpointLimitPerMin: 3 });
    const attempt = {
      method: 'POST' as const,
      url: '/v1/oauth/token',
      headers: FORM_HEADERS,
      payload: formBody({
        grant_type: 'client_credentials',
        client_id: THIRD_PARTY.clientId,
        client_secret: 'guessing',
      }),
    };

    for (let i = 0; i < 3; i += 1) {
      expect((await server.app.inject(attempt)).statusCode).toBe(401);
    }

    const limited = await server.app.inject(attempt);
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('counts each app separately, so a noisy client cannot starve another', async () => {
    server = await buildTestServer();
    server.store.setLimit(THIRD_PARTY.clientId, 2);
    server.store.setLimit(FIRST_PARTY.clientId, 2);

    const noisy = await mintAppToken(THIRD_PARTY);
    const quiet = await mintAppToken(FIRST_PARTY);

    for (let i = 0; i < 2; i += 1) {
      await server.app.inject({
        method: 'GET',
        url: '/v1/auth/context',
        headers: { authorization: `Bearer ${noisy}` },
      });
    }
    const noisyLimited = await server.app.inject({
      method: 'GET',
      url: '/v1/auth/context',
      headers: { authorization: `Bearer ${noisy}` },
    });
    const quietOk = await server.app.inject({
      method: 'GET',
      url: '/v1/auth/context',
      headers: { authorization: `Bearer ${quiet}` },
    });

    expect(noisyLimited.statusCode).toBe(429);
    expect(quietOk.statusCode).toBe(200);
  });
});

describe('error envelope and request ids (contract §8, D-044)', () => {
  it('404s an unknown route with the envelope rather than Fastify default JSON', async () => {
    server = await buildTestServer();
    const response = await server.app.inject({ method: 'GET', url: '/v1/nope' });
    expect(response.statusCode).toBe(404);
    expectEnvelope(response.body, 'not_found');
  });

  it('404s a malformed public id instead of failing with a 500', async () => {
    server = await buildTestServer();
    // Routes that take a public id arrive in S05; until then any id path is
    // unmatched, and the point of this assertion is that a hostile id shape
    // produces a clean 404 envelope rather than a stack trace.
    for (const id of [
      'po_NOTVALID',
      "po_'; drop table poster.posts; --",
      'po_' + 'A'.repeat(300),
    ]) {
      const response = await server.app.inject({
        method: 'GET',
        url: `/v1/posts/${encodeURIComponent(id)}`,
      });
      expect(response.statusCode, `id ${id}`).toBe(404);
      expectEnvelope(response.body, 'not_found');
    }
  });

  it('puts a request id on every response header', async () => {
    server = await buildTestServer();
    const ok = await server.app.inject({ method: 'GET', url: '/healthz' });
    const failed = await server.app.inject({ method: 'GET', url: '/v1/auth/context' });

    expect(ok.headers['x-request-id']).toBeTruthy();
    expect(failed.headers['x-request-id']).toBeTruthy();
  });

  it('adopts a caller-supplied X-Request-Id so their correlation id survives', async () => {
    server = await buildTestServer();
    const response = await server.app.inject({
      method: 'GET',
      url: '/v1/auth/context',
      headers: { 'x-request-id': 'client-correlation-42' },
    });

    expect(response.headers['x-request-id']).toBe('client-correlation-42');
    expect(expectEnvelope(response.body, 'invalid_token').error.request_id).toBe(
      'client-correlation-42',
    );
  });

  it('matches the header and the envelope request_id', async () => {
    server = await buildTestServer();
    const response = await server.app.inject({ method: 'GET', url: '/v1/auth/context' });
    const envelope = JSON.parse(response.body) as ErrorEnvelope;
    expect(envelope.error.request_id).toBe(response.headers['x-request-id']);
  });
});

describe('CORS (contract §2.2)', () => {
  it('allows an allow-listed origin', async () => {
    server = await buildTestServer();
    const response = await server.app.inject({
      method: 'OPTIONS',
      url: '/v1/auth/context',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
      },
    });
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('does not reflect an unknown origin, so no page can spend a user session', async () => {
    server = await buildTestServer();
    const response = await server.app.inject({
      method: 'OPTIONS',
      url: '/v1/auth/context',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'GET',
      },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
