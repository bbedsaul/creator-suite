/**
 * Envelope encryption for stored secrets (D-020, NFR-03).
 *
 * Each secret gets its own random data key (DEK); the DEK is wrapped by a key
 * manager and stored beside the ciphertext. Rotating the wrapping key therefore
 * means rewrapping DEKs rather than re-encrypting every secret, and a leaked
 * ciphertext is useless without the key manager.
 *
 * AES-256-GCM throughout, so every decrypt is authenticated: a tampered
 * ciphertext fails rather than returning plausible bytes. The production key
 * manager is a cloud KMS (TBD by M2); local development uses an env-held key
 * behind the same interface, so no code path differs between them.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class SecretDecryptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    // Deliberately says nothing about the secret or the key.
    super(message, options);
    this.name = 'SecretDecryptError';
  }
}

/**
 * Wraps and unwraps data keys. A cloud KMS implements this with a remote call; the
 * local implementation does it with a key from the environment.
 */
export interface KeyManager {
  /** Identifies the wrapping key, stored alongside so rotation is detectable. */
  readonly keyId: string;
  wrap(dek: Buffer): Promise<Buffer>;
  unwrap(wrapped: Buffer): Promise<Buffer>;
}

/** The three stored columns of an encrypted secret. */
export interface SealedSecret {
  readonly ciphertext: Buffer;
  readonly wrappedDek: Buffer;
  readonly nonce: Buffer;
  readonly keyId: string;
}

export interface LocalKeyManagerOptions {
  /** 32 bytes, base64. Generate with `openssl rand -base64 32`. */
  readonly masterKeyBase64: string;
  readonly keyId?: string;
}

/**
 * Development key manager. The master key lives in the environment, which is
 * exactly what a KMS exists to avoid, so this is never the production path.
 */
export function createLocalKeyManager(options: LocalKeyManagerOptions): KeyManager {
  const master = Buffer.from(options.masterKeyBase64, 'base64');
  if (master.length !== KEY_BYTES) {
    throw new Error(`master key must be ${String(KEY_BYTES)} bytes base64-encoded`);
  }

  return {
    keyId: options.keyId ?? 'local:v1',

    wrap(dek) {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(ALGORITHM, master, nonce);
      const wrapped = Buffer.concat([cipher.update(dek), cipher.final()]);
      // nonce || ciphertext || tag, so the wrapped blob is self-describing.
      return Promise.resolve(Buffer.concat([nonce, wrapped, cipher.getAuthTag()]));
    },

    unwrap(blob) {
      if (blob.length < NONCE_BYTES + TAG_BYTES) {
        throw new SecretDecryptError('wrapped key is too short to be valid');
      }
      const nonce = blob.subarray(0, NONCE_BYTES);
      const tag = blob.subarray(blob.length - TAG_BYTES);
      const body = blob.subarray(NONCE_BYTES, blob.length - TAG_BYTES);

      try {
        const decipher = createDecipheriv(ALGORITHM, master, nonce);
        decipher.setAuthTag(tag);
        return Promise.resolve(Buffer.concat([decipher.update(body), decipher.final()]));
      } catch (cause) {
        throw new SecretDecryptError('could not unwrap the data key', { cause });
      }
    },
  };
}

/** Encrypts a secret under a fresh data key. */
export async function sealSecret(plaintext: string, keys: KeyManager): Promise<SealedSecret> {
  const dek = randomBytes(KEY_BYTES);
  const nonce = randomBytes(NONCE_BYTES);

  const cipher = createCipheriv(ALGORITHM, dek, nonce);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  const sealed: SealedSecret = {
    // Tag appended so the stored ciphertext column is self-contained.
    ciphertext: Buffer.concat([body, cipher.getAuthTag()]),
    wrappedDek: await keys.wrap(dek),
    nonce,
    keyId: keys.keyId,
  };

  // The DEK has served its purpose; do not leave it in memory longer than needed.
  dek.fill(0);
  return sealed;
}

/**
 * Decrypts a stored secret. Throws SecretDecryptError on any failure, including a
 * tampered ciphertext, and never includes the secret or the key in the message.
 */
export async function openSecret(sealed: SealedSecret, keys: KeyManager): Promise<string> {
  if (sealed.ciphertext.length < TAG_BYTES) {
    throw new SecretDecryptError('ciphertext is too short to be valid');
  }

  const dek = await keys.unwrap(sealed.wrappedDek);
  try {
    if (dek.length !== KEY_BYTES)
      throw new SecretDecryptError('unwrapped key has the wrong length');

    const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - TAG_BYTES);
    const body = sealed.ciphertext.subarray(0, sealed.ciphertext.length - TAG_BYTES);

    const decipher = createDecipheriv(ALGORITHM, dek, sealed.nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch (cause) {
    if (cause instanceof SecretDecryptError) throw cause;
    throw new SecretDecryptError('could not decrypt the secret', { cause });
  } finally {
    dek.fill(0);
  }
}

/** Constant-time comparison, for anything that compares secret-derived bytes. */
export function secretsEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
