import { afterEach, describe, expect, it } from 'vitest';
import type { HealthResponse } from '../src/api/server.js';
import { buildTestServer, type TestServer } from './helpers/build-test-server.js';

let server: TestServer | undefined;

afterEach(async () => {
  await server?.app.close();
  server = undefined;
});

describe('GET /healthz', () => {
  it('returns 200 with the liveness payload', async () => {
    server = await buildTestServer();
    const response = await server.app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    const body = response.json<HealthResponse>();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('poster-api');
    expect(body.uptime_s).toBeGreaterThanOrEqual(0);
  });

  it('needs no credentials: a platform health probe cannot hold a token', async () => {
    server = await buildTestServer();
    const response = await server.app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
  });

  it('serves without a database or any frontend present (D-022)', async () => {
    server = await buildTestServer();
    expect(server.app.hasRoute({ method: 'GET', url: '/healthz' })).toBe(true);
  });
});

describe('unknown routes', () => {
  it('404s with the error envelope rather than crashing', async () => {
    server = await buildTestServer();
    const response = await server.app.inject({ method: 'GET', url: '/v1/does-not-exist-yet' });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('not_found');
  });
});
