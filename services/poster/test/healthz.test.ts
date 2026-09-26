import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildServer, type HealthResponse } from '../src/api/server.js';

const quiet = { ...loadConfig(), logLevel: 'fatal' } as const;

let app: ReturnType<typeof buildServer> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /healthz', () => {
  it('returns 200 with the liveness payload', async () => {
    app = buildServer(quiet);
    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    const body = response.json<HealthResponse>();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('poster-api');
    expect(body.uptime_s).toBeGreaterThanOrEqual(0);
  });

  it('serves without a database or any frontend present', async () => {
    // The service must boot and answer with nothing but its own process (D-022).
    app = buildServer(quiet);
    await app.ready();
    expect(app.hasRoute({ method: 'GET', url: '/healthz' })).toBe(true);
  });
});

describe('unknown routes', () => {
  it('404s rather than crashing', async () => {
    app = buildServer(quiet);
    const response = await app.inject({ method: 'GET', url: '/v1/does-not-exist-yet' });
    expect(response.statusCode).toBe(404);
  });
});
