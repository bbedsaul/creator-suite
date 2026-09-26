import { describe, expect, it } from 'vitest';
import { ARGON2_PARAMS, hashSecret, needsRehash, verifySecret } from '../src/secrets.js';

describe('hashSecret', () => {
  it('produces an argon2id hash at the OWASP baseline (D-045)', async () => {
    const hash = await hashSecret('correct horse battery staple');
    // Pins the library default: a change of variant must fail here, not silently
    // weaken every stored secret.
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).toContain(
      `m=${String(ARGON2_PARAMS.memoryCost)},t=${String(ARGON2_PARAMS.timeCost)},p=${String(ARGON2_PARAMS.parallelism)}`,
    );
  });

  it('salts, so the same secret never hashes to the same string twice', async () => {
    const [a, b] = await Promise.all([hashSecret('same'), hashSecret('same')]);
    expect(a).not.toBe(b);
  });
});

describe('verifySecret', () => {
  it('accepts the right secret and rejects a wrong one', async () => {
    const hash = await hashSecret('s3cret');
    expect(await verifySecret(hash, 's3cret')).toBe(true);
    expect(await verifySecret(hash, 's3cret ')).toBe(false);
    expect(await verifySecret(hash, 'S3cret')).toBe(false);
    expect(await verifySecret(hash, '')).toBe(false);
  });

  it('returns false for a corrupt stored hash instead of throwing', async () => {
    // A 500 here would tell an attacker they found an interesting row.
    expect(await verifySecret('not-a-hash', 'anything')).toBe(false);
    expect(await verifySecret('', 'anything')).toBe(false);
    expect(await verifySecret('$argon2id$v=19$m=x,t=y,p=z$bad$bad', 'anything')).toBe(false);
  });
});

describe('needsRehash', () => {
  it('is false for a hash at the current baseline', async () => {
    expect(needsRehash(await hashSecret('x'))).toBe(false);
  });

  it('is true when any parameter is below the baseline', () => {
    expect(needsRehash('$argon2id$v=19$m=4096,t=2,p=1$abc$def')).toBe(true);
    expect(needsRehash('$argon2id$v=19$m=19456,t=1,p=1$abc$def')).toBe(true);
  });

  it('is true for anything it cannot parse, so odd rows get upgraded', () => {
    expect(needsRehash('$2b$12$bcrypt-style-hash')).toBe(true);
    expect(needsRehash('')).toBe(true);
  });

  it('is false when parameters exceed the baseline, so raising cost is not undone', () => {
    expect(needsRehash('$argon2id$v=19$m=65536,t=3,p=4$abc$def')).toBe(false);
  });
});
