#!/usr/bin/env tsx
/**
 * One chaos run, in its own process so it can really be SIGKILLed.
 *
 * Runs a single real `dispatchTick` against the real database with the chaos
 * adapter, then dies at the scripted point. Nothing here is a simulation of the
 * dispatcher: it is the dispatcher, which is the only way the test says anything
 * about production behaviour.
 *
 * Usage (spawned by test/integration/chaos.test.ts):
 *   tsx crash-child.ts --platform tiktok --crash-at after_send --log /tmp/p.log \
 *     --worker chaos-7 [--race-ms 12]
 */
import postgres from 'postgres';
import { createLocalKeyManager } from '@suite/server-core';
import { createAdapterRegistry } from '../../src/adapters/registry.js';
import { createCredentialVault } from '../../src/vault/credentials.js';
import { dispatchTick } from '../../src/worker/dispatch-loop.js';
import { createChaosAdapter, type CrashPoint } from './chaos-adapter.js';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function required(name: string): string {
  const value = flag(name);
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}

const databaseUrl = process.env['POSTER_TEST_DATABASE_URL'] ?? required('database-url');
const masterKey = required('master-key');
const platformId = required('platform');
const publishLogPath = required('log');
const workerId = required('worker');
const crashAt = (flag('crash-at') ?? 'none') as CrashPoint;
const raceMs = flag('race-ms');

const sql = postgres(databaseUrl, { max: 4, onnotice: () => {} });

// `race` mode: die at an unpredictable moment so the windows the adapter cannot
// reach — after the claim, around the attempt-row insert, just before
// finish_dispatch — get exercised too.
if (raceMs !== undefined) {
  setTimeout(() => {
    process.kill(process.pid, 'SIGKILL');
  }, Number(raceMs));
}

const adapter = createChaosAdapter({ publishLogPath, crashAt });
const registry = createAdapterRegistry([adapter]);

const silent = { info: () => {}, warn: () => {}, error: () => {} };

try {
  const result = await dispatchTick(
    {
      platformId,
      concurrency: 1,
      pollIntervalMs: 50,
      // Long enough that nothing expires during the run itself: the parent
      // expires the lease deliberately once the child is dead.
      leaseMs: 120_000,
      publishTimeoutMs: 30_000,
    },
    {
      sql,
      vault: createCredentialVault(sql, createLocalKeyManager({ masterKeyBase64: masterKey })),
      adapterFor: (platform) => registry.for(platform),
      workerId,
      logger: silent,
    },
  );

  process.stdout.write(`${JSON.stringify(result)}\n`);
  await sql.end({ timeout: 2 });
  process.exit(0);
} catch (error) {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
}
