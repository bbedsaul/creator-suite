/**
 * The client is generated types plus a thin runtime. What is worth testing is
 * that runtime: that it attaches a fresh token per request, and that `unwrap`
 * turns the contract envelope into something a caller can switch on.
 */
import { describe, expect, it, vi } from 'vitest';
import { PosterError, TARGET_CONTRACT_VERSION, createPosterClient, unwrap } from '../src/index.js';

const BASE = 'https://poster.test';

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('contract version', () => {
  it('targets the version the schemas were generated from (D-027)', () => {
    expect(TARGET_CONTRACT_VERSION).toBe('1.4');
  });
});

describe('createPosterClient', () => {
  it('sends the bearer token from getToken', async () => {
    const fetchMock = vi.fn((_request: Request) =>
      Promise.resolve(
        jsonResponse(200, {
          mode: 'app',
          app: { client_id: 'trainer-dev', first_party: false },
          user_id: null,
        }),
      ),
    );

    const client = createPosterClient({
      baseUrl: BASE,
      getToken: () => 'token-abc',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await client.GET('/v1/auth/context');

    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.headers.get('authorization')).toBe('Bearer token-abc');
  });

  it('asks for a token on every request, because app tokens expire every 15 minutes', async () => {
    let issued = 0;
    const fetchMock = vi.fn((_request: Request) =>
      Promise.resolve(jsonResponse(200, { mode: 'app' })),
    );

    const client = createPosterClient({
      baseUrl: BASE,
      getToken: () => `token-${String(++issued)}`,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await client.GET('/v1/auth/context');
    await client.GET('/v1/auth/context');

    const first = fetchMock.mock.calls[0]?.[0] as Request;
    const second = fetchMock.mock.calls[1]?.[0] as Request;
    expect(first.headers.get('authorization')).toBe('Bearer token-1');
    expect(second.headers.get('authorization')).toBe('Bearer token-2');
  });

  it('awaits an async token provider', async () => {
    const fetchMock = vi.fn((_request: Request) => Promise.resolve(jsonResponse(200, {})));
    const client = createPosterClient({
      baseUrl: BASE,
      getToken: () => Promise.resolve('async-token'),
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await client.GET('/v1/auth/context');
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.headers.get('authorization')).toBe('Bearer async-token');
  });

  it('sends no Authorization header when there is no token yet', async () => {
    const fetchMock = vi.fn((_request: Request) => Promise.resolve(jsonResponse(200, {})));
    const client = createPosterClient({
      baseUrl: BASE,
      getToken: () => undefined,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await client.GET('/v1/auth/context');
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.headers.has('authorization')).toBe(false);
  });
});

describe('unwrap', () => {
  it('returns the data on success', () => {
    const data = { mode: 'app' as const };
    expect(unwrap({ data, response: new Response(null, { status: 200 }) })).toBe(data);
  });

  it('throws a PosterError carrying the code and request id', () => {
    const response = new Response(null, { status: 403, headers: { 'x-request-id': 'req-9' } });
    try {
      unwrap({
        error: {
          error: {
            code: 'forbidden_user',
            message: 'A user-mode token may only act for its own user',
            request_id: 'req-9',
          },
        },
        response,
      });
      expect.unreachable();
    } catch (thrown) {
      const error = thrown as PosterError;
      expect(error).toBeInstanceOf(PosterError);
      expect(error.status).toBe(403);
      expect(error.error.code).toBe('forbidden_user');
      // The whole point of request_id: a caller can quote it (D-044).
      expect(error.requestId).toBe('req-9');
    }
  });

  it('falls back to the response header when a proxy ate the envelope', () => {
    const response = new Response(null, { status: 502, headers: { 'x-request-id': 'req-edge' } });
    try {
      unwrap({ error: 'Bad Gateway', response });
      expect.unreachable();
    } catch (thrown) {
      const error = thrown as PosterError;
      expect(error.error.code).toBe('internal_error');
      expect(error.requestId).toBe('req-edge');
    }
  });

  it('throws rather than returning undefined when a response carries neither', () => {
    expect(() => unwrap({ response: new Response(null, { status: 204 }) })).toThrow(PosterError);
  });

  it('exposes constraint details so a client can fix the failing target (FR-06)', () => {
    try {
      unwrap({
        error: {
          error: {
            code: 'constraint_violation',
            message: '1 of 2 targets failed validation',
            request_id: 'req-10',
            details: [{ target_index: 1, code: 'video_too_long' }],
          },
        },
        response: new Response(null, { status: 422 }),
      });
      expect.unreachable();
    } catch (thrown) {
      const error = thrown as PosterError;
      expect(error.error.details?.[0]).toMatchObject({ target_index: 1, code: 'video_too_long' });
    }
  });
});
