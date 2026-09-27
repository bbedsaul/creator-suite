/**
 * Envelope encryption (D-020, NFR-03).
 *
 * The properties that matter are the ones a leak depends on: a per-secret data
 * key so one compromise is not all of them, authenticated encryption so tampering
 * fails loudly, and errors that say nothing about the plaintext or the key.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SecretDecryptError,
  createLocalKeyManager,
  openSecret,
  sealSecret,
  secretsEqual,
} from '../src/envelope.js';

const masterKeyBase64 = randomBytes(32).toString('base64');
const keys = createLocalKeyManager({ masterKeyBase64 });

describe('createLocalKeyManager', () => {
  it('rejects a master key that is not 32 bytes', () => {
    expect(() => createLocalKeyManager({ masterKeyBase64: 'c2hvcnQ=' })).toThrow(/32 bytes/);
  });

  it('reports a key id, so a rotation is detectable from a stored row', () => {
    expect(keys.keyId).toBe('local:v1');
    expect(createLocalKeyManager({ masterKeyBase64, keyId: 'local:v2' }).keyId).toBe('local:v2');
  });
});

describe('sealSecret / openSecret', () => {
  it('round-trips a secret', async () => {
    const sealed = await sealSecret('aggregator-profile-key-abc123', keys);
    await expect(openSecret(sealed, keys)).resolves.toBe('aggregator-profile-key-abc123');
  });

  it('round-trips non-ASCII and long values', async () => {
    for (const secret of ['clé-très-secrète 🔐', 'x'.repeat(8192), '']) {
      const sealed = await sealSecret(secret, keys);
      await expect(openSecret(sealed, keys)).resolves.toBe(secret);
    }
  });

  it('never stores the plaintext in the ciphertext', async () => {
    const sealed = await sealSecret('needle-in-a-haystack', keys);
    expect(sealed.ciphertext.toString('utf8')).not.toContain('needle');
    expect(sealed.wrappedDek.toString('utf8')).not.toContain('needle');
  });

  it('uses a fresh data key each time, so the same secret seals differently', async () => {
    const a = await sealSecret('same', keys);
    const b = await sealSecret('same', keys);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false);
  });

  it('records which wrapping key was used', async () => {
    expect((await sealSecret('x', keys)).keyId).toBe('local:v1');
  });
});

describe('tampering', () => {
  it('rejects a modified ciphertext rather than returning bytes', async () => {
    const sealed = await sealSecret('do-not-tamper', keys);
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;

    await expect(openSecret({ ...sealed, ciphertext: tampered }, keys)).rejects.toThrow(
      SecretDecryptError,
    );
  });

  it('rejects a modified wrapped key', async () => {
    const sealed = await sealSecret('do-not-tamper', keys);
    const tampered = Buffer.from(sealed.wrappedDek);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;

    await expect(openSecret({ ...sealed, wrappedDek: tampered }, keys)).rejects.toThrow(
      SecretDecryptError,
    );
  });

  it('rejects a swapped nonce', async () => {
    const sealed = await sealSecret('do-not-tamper', keys);
    await expect(openSecret({ ...sealed, nonce: randomBytes(12) }, keys)).rejects.toThrow(
      SecretDecryptError,
    );
  });

  it('refuses a different master key', async () => {
    const sealed = await sealSecret('do-not-tamper', keys);
    const other = createLocalKeyManager({ masterKeyBase64: randomBytes(32).toString('base64') });
    await expect(openSecret(sealed, other)).rejects.toThrow(SecretDecryptError);
  });

  it('rejects truncated blobs instead of throwing something unexpected', async () => {
    const sealed = await sealSecret('x', keys);
    await expect(openSecret({ ...sealed, ciphertext: Buffer.alloc(4) }, keys)).rejects.toThrow(
      SecretDecryptError,
    );
    await expect(openSecret({ ...sealed, wrappedDek: Buffer.alloc(4) }, keys)).rejects.toThrow(
      SecretDecryptError,
    );
  });

  it('says nothing about the secret or the key in its message', async () => {
    const sealed = await sealSecret('super-secret-value', keys);
    try {
      await openSecret({ ...sealed, nonce: randomBytes(12) }, keys);
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain('super-secret');
      expect(message).not.toContain(masterKeyBase64);
    }
  });
});

describe('secretsEqual', () => {
  it('compares equal buffers', () => {
    expect(secretsEqual(Buffer.from('abc'), Buffer.from('abc'))).toBe(true);
  });

  it('is false for different lengths without throwing', () => {
    expect(secretsEqual(Buffer.from('abc'), Buffer.from('abcd'))).toBe(false);
  });
});
