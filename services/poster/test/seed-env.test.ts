/**
 * .env.local merging is pure string work, so it is worth unit-testing away from
 * the database: the failure mode is silently clobbering a developer's working
 * secret, which an integration test would not notice.
 */
import { describe, expect, it } from 'vitest';
import { envVarName, mergeEnvLocal, type SeedEntry } from '../src/seed.js';

describe('envVarName', () => {
  it('upper-snakes a client id', () => {
    expect(envVarName('poster-web')).toBe('SEED_SECRET_POSTER_WEB');
    expect(envVarName('test-client')).toBe('SEED_SECRET_TEST_CLIENT');
  });
});

describe('mergeEnvLocal', () => {
  const created: SeedEntry[] = [
    { clientId: 'poster-web', status: 'created', secret: 'new-secret' },
  ];

  it('writes a secret into an empty file', () => {
    expect(mergeEnvLocal('', created)).toBe('SEED_SECRET_POSTER_WEB=new-secret\n');
  });

  it('leaves unrelated lines alone', () => {
    const result = mergeEnvLocal('DATABASE_URL=postgres://local\n', created);
    expect(result).toContain('DATABASE_URL=postgres://local');
    expect(result).toContain('SEED_SECRET_POSTER_WEB=new-secret');
  });

  it('replaces the line for a rotated app', () => {
    const result = mergeEnvLocal('SEED_SECRET_POSTER_WEB=old-secret\n', [
      { clientId: 'poster-web', status: 'rotated', secret: 'rotated-secret' },
    ]);
    expect(result).toContain('SEED_SECRET_POSTER_WEB=rotated-secret');
    expect(result).not.toContain('old-secret');
  });

  it('keeps an existing secret for a preserved app', () => {
    // The point of preserving: the value already on disk must stay valid.
    const result = mergeEnvLocal('SEED_SECRET_TRAINER_DEV=still-good\n', [
      { clientId: 'trainer-dev', status: 'preserved' },
    ]);
    expect(result).toContain('SEED_SECRET_TRAINER_DEV=still-good');
  });

  it('does not duplicate a key when re-run', () => {
    const once = mergeEnvLocal('', created);
    const twice = mergeEnvLocal(once, created);
    expect(twice.match(/SEED_SECRET_POSTER_WEB=/g)).toHaveLength(1);
  });

  it('ends with exactly one trailing newline', () => {
    expect(mergeEnvLocal('A=1\n', created).endsWith('\n')).toBe(true);
    expect(mergeEnvLocal('A=1\n', created)).not.toContain('\n\n');
  });
});
