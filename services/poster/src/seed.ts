/**
 * Registers the development client apps: poster-web, trainer-dev, test-client.
 *
 *   pnpm -F @suite/poster-service seed
 *   pnpm -F @suite/poster-service seed -- --rotate
 *
 * Secrets are generated, hashed with argon2id, and written to a gitignored
 * .env.local; the plaintext is shown once and never stored (D-049).
 *
 * Re-running **preserves** an existing app's secret by default and only reports
 * what it created (D-051). That matters because running the integration suite
 * runs this script, and rotating on every run would silently invalidate the
 * secrets a developer already has in .env.local. Pass `--rotate` to deliberately
 * issue new secrets.
 *
 * `test-client` is the exception: it always carries a fixed, published secret so
 * integration tests do not depend on generated state. That is safe precisely
 * because it is published here — it must never be granted anything in a real
 * environment.
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

export type SeedStatus = 'created' | 'rotated' | 'preserved';

export interface SeedEntry {
  readonly clientId: string;
  readonly status: SeedStatus;
  /**
   * The plaintext secret, when this run knows it. Absent for a preserved app:
   * only the hash is stored, so a preserved secret is unknowable by design.
   */
  readonly secret?: string;
}

export interface SeedOptions {
  /** Issue new secrets for apps that already exist. Default false. */
  readonly rotate?: boolean;
}

function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}

export async function seed(databaseUrl: string, options: SeedOptions = {}): Promise<SeedEntry[]> {
  const sql = createPool({ databaseUrl, max: 2 });
  const results: SeedEntry[] = [];

  try {
    for (const app of APPS) {
      const existing = await sql<{ id: string }[]>`
        select id from poster.client_apps where client_id = ${app.clientId}`;
      const exists = existing.length > 0;

      // A fixed-secret app is always written: the secret is known either way, so
      // there is nothing to preserve and asserting the stored hash keeps the
      // published test credential working.
      const shouldWriteSecret = !exists || options.rotate === true || app.fixedSecret !== undefined;

      if (shouldWriteSecret) {
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
        results.push({
          clientId: app.clientId,
          status: exists ? 'rotated' : 'created',
          secret,
        });
      } else {
        // Keep the secret, refresh everything else so metadata changes still land.
        await sql`
          update poster.client_apps
             set name               = ${app.name},
                 first_party        = ${app.firstParty},
                 rate_limit_per_min = ${app.rateLimitPerMin},
                 disabled_at        = null
           where client_id = ${app.clientId}`;
        results.push({ clientId: app.clientId, status: 'preserved' });
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  return results;
}

export function envVarName(clientId: string): string {
  return `SEED_SECRET_${clientId.replace(/-/g, '_').toUpperCase()}`;
}

/**
 * Merges the known secrets into .env.local without disturbing anything else,
 * and without clobbering a preserved app's existing line — the whole point of
 * preserving a secret is that the one already on disk stays valid.
 */
export function mergeEnvLocal(existing: string, entries: readonly SeedEntry[]): string {
  const managed = new Map<string, string>();
  const other: string[] = [];

  for (const line of existing.split('\n')) {
    const match = /^(SEED_SECRET_[A-Z0-9_]+)=(.*)$/.exec(line);
    if (match?.[1] !== undefined) managed.set(match[1], match[2] ?? '');
    else if (line.trim() !== '') other.push(line);
  }

  for (const entry of entries) {
    if (entry.secret !== undefined) managed.set(envVarName(entry.clientId), entry.secret);
  }

  const lines = [...other, ...[...managed].map(([key, value]) => `${key}=${value}`)];
  return `${lines.join('\n')}\n`;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry?.endsWith('seed.js') === true || entry?.endsWith('seed.ts') === true;
}

if (isDirectRun()) {
  const databaseUrl = requireEnv('DATABASE_URL');
  const rotate = process.argv.includes('--rotate');
  const repoRoot = join(import.meta.dirname, '..', '..', '..');
  const envPath = join(repoRoot, '.env.local');

  const entries = await seed(databaseUrl, { rotate });

  let existing = '';
  try {
    existing = readFileSync(envPath, 'utf8');
  } catch {
    existing = '';
  }
  writeFileSync(envPath, mergeEnvLocal(existing, entries), 'utf8');

  console.log(`Client apps (${rotate ? 'rotating' : 'preserving existing secrets'}):\n`);
  for (const entry of entries) {
    const shown =
      entry.clientId === TEST_CLIENT_ID
        ? (entry.secret ?? '')
        : entry.secret === undefined
          ? 'unchanged'
          : `${entry.secret.slice(0, 6)}… (see .env.local)`;
    console.log(`  ${entry.clientId.padEnd(14)} ${entry.status.padEnd(10)} ${shown}`);
  }

  const wrote = entries.filter((entry) => entry.secret !== undefined).length;
  console.log(`\n${String(wrote)} secret(s) written to .env.local (gitignored).`);
  if (!rotate) console.log('Existing secrets were preserved; pass --rotate to issue new ones.');
}
