/**
 * Secret references (contract §2.1: secrets live in the secrets manager, and the
 * database holds only a reference).
 */
import { describe, expect, it } from 'vitest';
import {
  InvalidSecretRefError,
  SecretNotFoundError,
  createEnvSecretsManager,
  createStaticSecretsManager,
} from '../src/secrets-manager.js';

describe('createEnvSecretsManager', () => {
  const env = { WEBHOOK_SECRET_POSTER_WEB: 'shh', DATABASE_URL: 'postgres://secret', EMPTY: '' };
  const manager = createEnvSecretsManager(env as unknown as NodeJS.ProcessEnv);

  it('resolves an env reference', async () => {
    await expect(manager.get('env:WEBHOOK_SECRET_POSTER_WEB')).resolves.toBe('shh');
  });

  it('rejects a reference that is not the env scheme', async () => {
    for (const ref of ['WEBHOOK_SECRET_POSTER_WEB', 'aws:thing', 'env:', '']) {
      await expect(manager.get(ref)).rejects.toThrow(InvalidSecretRefError);
    }
  });

  it('rejects lowercase and path-like names', async () => {
    // A ref comes from the database. Without this, whoever can write
    // webhook_secret_ref could read any variable the process holds.
    for (const ref of ['env:database_url', 'env:../DATABASE_URL', 'env:A-B', 'env:A B']) {
      await expect(manager.get(ref)).rejects.toThrow(InvalidSecretRefError);
    }
  });

  it('still refuses an unset or empty variable rather than returning nothing', async () => {
    await expect(manager.get('env:NOT_SET')).rejects.toThrow(SecretNotFoundError);
    await expect(manager.get('env:EMPTY')).rejects.toThrow(SecretNotFoundError);
  });

  it('never puts the value in the error message', async () => {
    try {
      await manager.get('env:NOT_SET');
    } catch (error) {
      expect((error as Error).message).toContain('env:NOT_SET');
      expect((error as Error).message).not.toContain('shh');
    }
  });
});

describe('createStaticSecretsManager', () => {
  const manager = createStaticSecretsManager({ 'app:1': 'secret-one' });

  it('resolves a known reference', async () => {
    await expect(manager.get('app:1')).resolves.toBe('secret-one');
  });

  it('throws for an unknown one', async () => {
    await expect(manager.get('app:2')).rejects.toThrow(SecretNotFoundError);
  });
});
