/**
 * The contract doc and the schemas must agree (D-027).
 *
 * The `contract-change` skill requires bumping the doc's version in the same
 * commit as a schema change. Until now that was discipline; this makes it a
 * failing test, which is the only kind of rule that survives a busy session.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION } from '../src/version.js';

const doc = readFileSync(
  fileURLToPath(new URL('../../../docs/social-poster-internal-api-contract.md', import.meta.url)),
  'utf8',
);

describe('contract doc', () => {
  it('declares the same version as the schemas', () => {
    const title = /^# Social Poster — Internal API Contract \(v([0-9]+\.[0-9]+)\)/m.exec(doc);
    expect(title?.[1], 'could not find the version in the doc title').toBeDefined();
    expect(title?.[1]).toBe(CONTRACT_VERSION);
  });

  it('has a changelog entry for the current version', () => {
    expect(
      doc.includes(`**v${CONTRACT_VERSION} changes`),
      `no "v${CONTRACT_VERSION} changes" section; the contract-change skill requires one`,
    ).toBe(true);
  });

  it('documents every error code the schemas define', () => {
    // A code a client can receive but cannot look up is not much of a contract.
    for (const code of ['invalid_token', 'forbidden_user', 'rate_limited', 'not_found']) {
      expect(doc, `§8 does not mention ${code}`).toContain(`\`${code}\``);
    }
  });

  it('documents the routes the spec exposes', () => {
    for (const route of ['/v1/oauth/token', '/v1/auth/context']) {
      expect(doc, `${route} is in the spec but not the doc`).toContain(route);
    }
  });
});
