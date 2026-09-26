/**
 * Registers the development client apps: poster-web, trainer-dev, test-client.
 *
 *   pnpm -F @suite/poster-service seed
 *
 * Secrets are generated, hashed with argon2id, and written to a gitignored
 * .env.local; the plaintext is shown once and never stored (D-049). `test-client`
 * is the exception: it gets a fixed, well-known secret so integration tests do
 * not depend on generated state. That is safe precisely because it is published
 * here — it must never be granted anything in a real environment.
 *
 * Re-running is safe: an existing client_id has its secret rotated rather than
 * duplicated, so a developer who loses .env.local just runs it again.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashSecret, requireEnv } from '@suite/server-core';
import { createPool } from './db/pool.js';

/** Published on purpose so tests can hardcode it. Never grant this app anything real. */
export const TEST_CLIENT_ID = 'test-client';
export const TEST_CLIENT_SECRET = 'test-client-secret-do-not-use-outside-tests';

interface SeedApp {
  readonly clientId: string;
  readonly name: string;
  readonly firstParty: boolean;
  readonly rateLimitPerMin: number;
  /** Fixed secret, or undefined to generate one. */
  readonly fixedSecret?: string;
}

const APPS: readonly SeedApp[] = [
  {
    clientId: 'poster-web',
    name: 'Poster Composer (first-party)',
    firstParty: true,
    rateLimitPerMin: 600,
  },
  {
    clientId: 'trainer-dev',
    name: 'Trainer (development)',
    firstParty: false,
    rateLimitPerMin: 600,
  },
  {
    clientId: TEST_CLIENT_ID,
    name: 'Integration test client',
    firstParty: false,
    rateLimitPerMin: 600,
    fixedSecret: TEST_CLIENT_SECRET,
  },
];

function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}

export async function seed(databaseUrl: string): Promise<Map<string, string>> {
  const sql = createPool({ databaseUrl, max: 2 });
  const secrets = new Map<string, string>();

  try {
    for (const app of APPS) {
      const secret = app.fixedSecret ?? generateSecret();
      const hash = await hashSecret(secret);
      await sql`
        insert into poster.client_apps
          (client_id, name, client_secret_hash, first_party, rate_limit_per_min)
        values (${app.clientId}, ${app.name}, ${hash}, ${app.firstParty}, ${app.rateLimitPerMin})
        on conflict (client_id) do update
           set client_secret_hash = excluded.client_secret_hash,
               name               = excluded.name,
               first_party        = excluded.first_party,
               rate_limit_per_min = excluded.rate_limit_per_min,
               disabled_at        = null`;
      secrets.set(app.clientId, secret);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  return secrets;
}

/** Writes or replaces the SEED_* lines in .env.local without disturbing the rest. */
function writeEnvLocal(repoRoot: string, secrets: Map<string, string>): string {
  const path = join(repoRoot, '.env.local');
  let existing = '';
  try {
    existing = readFileSync(path, 'utf8');
  } catch {
    existing = '';
  }

  const managed = [...secrets]
    .map(
      ([clientId, secret]) => `SEED_SECRET_${clientId.replace(/-/g, '_').toUpperCase()}=${secret}`,
    )
    .join('\n');

  const kept = existing
    .split('\n')
    .filter((line) => !line.startsWith('SEED_SECRET_'))
    .join('\n')
    .trimEnd();

  const body = `${kept === '' ? '' : `${kept}\n`}${managed}\n`;
  writeFileSync(path, body, 'utf8');
  return path;
}

if (
  process.argv[1]?.endsWith('seed.js') === true ||
  process.argv[1]?.endsWith('seed.ts') === true
) {
  const databaseUrl = requireEnv('DATABASE_URL');
  const repoRoot = join(import.meta.dirname, '..', '..', '..');
  const secrets = await seed(databaseUrl);
  const path = writeEnvLocal(repoRoot, secrets);

  console.log('Registered client apps:\n');
  for (const [clientId, secret] of secrets) {
    const shown = clientId === TEST_CLIENT_ID ? secret : `${secret.slice(0, 6)}… (see .env.local)`;
    console.log(`  ${clientId.padEnd(14)} ${shown}`);
  }
  console.log(`\nSecrets written to ${path.replace(`${repoRoot}/`, '')} (gitignored).`);
  console.log('Plaintext secrets are not stored anywhere else; re-run to rotate.');
}
