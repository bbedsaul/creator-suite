/**
 * Guards the adapter fixtures themselves.
 *
 * The live half of S09 re-records these from real provider responses
 * (test/fixtures/adapters/PROVENANCE.md), and the obvious way for that to go
 * wrong is a real API key pasted in with the response that quoted it. This is a
 * tripwire for that, not a proof: it flags long opaque strings and requires each
 * one to be named, so adding a real credential means editing an allowlist in the
 * same commit rather than doing it silently.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RecordedResponse } from './helpers/adapter-fixtures.js';

const ROOT = join(import.meta.dirname, 'fixtures', 'adapters');
const PROVIDERS = ['upload-post', 'ayrshare'] as const;

/**
 * Real API keys are opaque and long. 32 characters is the threshold because
 * shorter identifiers in these fixtures are platform post ids and job handles,
 * and flagging those would train us to ignore the check.
 */
const OPAQUE = /^[A-Za-z0-9_.-]{32,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Long opaque strings that are known, named, and not credentials. */
const KNOWN_OPAQUE = new Map<string, string>([
  [
    '13a9da9e0df1183a7a6a1fc2c60b8023fa9a32a0',
    "Ayrshare's `refId`, a User Profile reference. Taken verbatim from their " +
      'public documentation example, and not a credential: it identifies a profile ' +
      'and cannot authorise anything on its own.',
  ],
]);

function collectStrings(node: unknown, out: string[]): void {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const child of node) collectStrings(child, out);
  else if (node !== null && typeof node === 'object') {
    for (const child of Object.values(node)) collectStrings(child, out);
  }
}

function fixtureFiles(): { provider: string; file: string; path: string }[] {
  return PROVIDERS.flatMap((provider) =>
    readdirSync(join(ROOT, provider))
      .filter((file) => file.endsWith('.json'))
      .map((file) => ({ provider, file, path: join(ROOT, provider, file) })),
  );
}

describe('adapter fixtures', () => {
  it('has fixtures for both providers', () => {
    const files = fixtureFiles();
    expect(files.filter((entry) => entry.provider === 'upload-post').length).toBeGreaterThan(0);
    expect(files.filter((entry) => entry.provider === 'ayrshare').length).toBeGreaterThan(0);
  });

  it.each(fixtureFiles())('$provider/$file is a map of recorded responses', ({ path }) => {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, RecordedResponse>;
    expect(Object.keys(parsed).length).toBeGreaterThan(0);

    for (const [name, recorded] of Object.entries(parsed)) {
      expect(typeof recorded.status, `${name}.status`).toBe('number');
      expect(recorded.status, `${name}.status`).toBeGreaterThanOrEqual(200);
      expect(recorded, `${name}.body`).toHaveProperty('body');
    }
  });

  it.each(fixtureFiles())('$provider/$file contains no unexplained opaque string', ({ path }) => {
    const strings: string[] = [];
    collectStrings(JSON.parse(readFileSync(path, 'utf8')), strings);

    const suspicious = strings
      .filter((value) => OPAQUE.test(value))
      .filter((value) => !UUID.test(value))
      .filter((value) => !KNOWN_OPAQUE.has(value));

    expect(
      suspicious,
      'Long opaque strings must be named in KNOWN_OPAQUE with a reason, or scrubbed. ' +
        'If one of these is a real API key, remove it: fixtures are committed.',
    ).toEqual([]);
  });

  it('documents its provenance, including that these are doc shapes not recordings', () => {
    const provenance = readFileSync(join(ROOT, 'PROVENANCE.md'), 'utf8');
    expect(provenance).toContain('documented shapes, not live recordings');
    for (const { provider, file } of fixtureFiles()) {
      expect(provenance, `${provider}/${file} is missing from PROVENANCE.md`).toContain(
        `${provider}/${file}`,
      );
    }
  });
});
