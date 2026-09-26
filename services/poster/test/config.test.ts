import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const touched = ['PORT', 'LOG_LEVEL', 'HOST', 'WORKER_TICK_MS'] as const;
const saved = new Map(touched.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of touched) {
    const original = saved.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

describe('loadConfig', () => {
  it('defaults to port 8080 on 0.0.0.0 so a container is reachable', () => {
    delete process.env['PORT'];
    delete process.env['HOST'];
    const config = loadConfig();
    expect(config.port).toBe(8080);
    expect(config.host).toBe('0.0.0.0');
  });

  it('reads PORT from the environment', () => {
    process.env['PORT'] = '9123';
    expect(loadConfig().port).toBe(9123);
  });

  it('rejects an unknown LOG_LEVEL instead of silently defaulting', () => {
    process.env['LOG_LEVEL'] = 'chatty';
    expect(() => loadConfig()).toThrow(/LOG_LEVEL must be one of/);
  });
});
