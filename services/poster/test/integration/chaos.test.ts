/**
 * Crash safety: 100 SIGKILLs around the adapter call, and zero double-posts
 * (S07 acceptance criteria, D-012, NFR-02).
 *
 * Each run spawns a real child process that runs a real `dispatchTick` and then
 * genuinely SIGKILLs itself. The "platform" is a file the chaos adapter appends to
 * before returning, so the record of what was published survives the kill — an
 * in-memory counter would die with the process and prove nothing.
 *
 * The invariant is one line per target in that file, forever, regardless of how
 * many times the worker died and the reconciler ran.
 *
 * Requires a running local stack (`pnpm exec supabase start`).
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalKeyManager } from '@suite/server-core';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAdapterRegistry } from '../../src/adapters/registry.js';
import { createCredentialVault, type CredentialVault } from '../../src/vault/credentials.js';
import { reconcileTick, startReconcileLoop } from '../../src/worker/reconcile-loop.js';
import { dispatchTick } from '../../src/worker/dispatch-loop.js';
import { loadConstraints, readSpecs, specDirectory } from '../../src/seed-constraints.js';
import { TEST_CLIENT_ID, seed } from '../../src/seed.js';
import { createChaosAdapter, publishCountFor, readPublishLog } from '../chaos/chaos-adapter.js';

const DATABASE_URL =
  process.env['POSTER_TEST_DATABASE_URL'] ??
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const repoRoot = process.cwd().replace(/\/services\/poster$/, '');
const MASTER_KEY = randomBytes(32).toString('base64');

/** How many chaos runs. The acceptance criterion says 100. */
const RUNS = 100;

const ids = { user: crypto.randomUUID(), connection: crypto.randomUUID() };

const sql = postgres(DATABASE_URL, { max: 12, onnotice: () => {} });
const keys = createLocalKeyManager({ masterKeyBase64: MASTER_KEY });

let vault: CredentialVault;
let appId = '';
let directory = '';
let reachable = false;

const silent = { info: () => {}, warn: () => {}, error: () => {} };

const reconcileConfig = { batchSize: 50, pollIntervalMs: 50, lookupTimeoutMs: 5_000 };

async function cleanup(): Promise<void> {
  await sql`delete from poster.posts where user_id = ${ids.user}`;
  await sql`delete from poster.connections where user_id = ${ids.user}`;
  await sql`delete from poster.credentials where user_id = ${ids.user}`;
  await sql`delete from auth.users where id = ${ids.user}`;
}

async function createTarget(): Promise<string> {
  const posts = await sql<{ id: string }[]>`
    insert into poster.posts (user_id, app_id, content)
    values (${ids.user}, ${appId}, ${sql.json({ text: 'chaos' } as never)})
    returning id`;
  const targets = await sql<{ id: string }[]>`
    insert into poster.post_targets
      (post_id, user_id, connection_id, platform_id, position, due_at, state)
    values (${posts[0]?.id as string}, ${ids.user}, ${ids.connection}, 'tiktok', 0,
            now() - interval '1 second', 'scheduled')
    returning id`;
  return targets[0]?.id as string;
}

/** Runs one child to completion (or to its own death) and reports how it ended. */
function runChild(
  args: readonly string[],
): Promise<{ signal: string | null; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node_modules/.bin/tsx', ['test/chaos/crash-child.ts', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, POSTER_TEST_DATABASE_URL: DATABASE_URL },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      // tsx runs the script in an inner process, so our self-SIGKILL reaches us as
      // the wrapper exiting 137 (128 + SIGKILL) with signal null rather than as a
      // signalled exit. Both mean "it crashed as instructed".
      const killed = signal === 'SIGKILL' || code === 137;
      if (!killed && code !== 0) {
        reject(new Error(`chaos child failed (code ${String(code)}): ${stderr}`));
        return;
      }
      resolve({ signal, code });
    });
  });
}

/** Simulates the lease expiring, so 100 runs do not take 100 lease durations. */
async function expireLease(targetId: string): Promise<void> {
  await sql`
    update poster.post_targets set claim_expires_at = now() - interval '1 second'
     where id = ${targetId} and state = 'dispatching'`;
}

beforeAll(async () => {
  try {
    await sql`select 1`;
    reachable = true;
  } catch {
    return;
  }

  directory = await mkdtemp(join(tmpdir(), 'poster-chaos-'));

  await cleanup();
  await seed(DATABASE_URL);
  await loadConstraints(DATABASE_URL, readSpecs(specDirectory(repoRoot)));

  const apps = await sql<{ id: string }[]>`
    select id from poster.client_apps where client_id = ${TEST_CLIENT_ID}`;
  appId = apps[0]?.id as string;

  await sql`
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
    values (${ids.user}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`chaos-${ids.user}@example.test`}, 'x', now(), now())`;

  vault = createCredentialVault(sql, keys);
  const credentialId = await vault.store({
    userId: ids.user,
    kind: 'aggregator_profile',
    provider: 'chaos',
    secret: 'chaos-credential-never-logged',
  });

  await sql`
    insert into poster.connections (id, user_id, platform_id, credential_id, external_account_id)
    values (${ids.connection}, ${ids.user}, 'tiktok', ${credentialId}, ${`tt-${ids.connection}`})`;
}, 120_000);

afterAll(async () => {
  if (reachable) await cleanup();
  if (directory !== '') await rm(directory, { recursive: true, force: true });
  await sql.end({ timeout: 5 });
});

describe('environment', () => {
  it('has a reachable database', () => {
    expect(reachable, `need a local stack for ${DATABASE_URL}`).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The reconciler's three branches, asserted individually before the volume test.
// ---------------------------------------------------------------------------
describe('reconciliation of a stale dispatch (D-012)', () => {
  function deps(logPath: string, forceLookup?: 'unknown') {
    const adapter = createChaosAdapter({
      publishLogPath: logPath,
      ...(forceLookup === undefined ? {} : { forceLookup: { kind: 'unknown' } }),
    });
    const registry = createAdapterRegistry([adapter]);
    return {
      sql,
      vault,
      adapterFor: (platformId: string) => registry.for(platformId),
      logger: silent,
      workerId: 'reconcile-test',
    };
  }

  it('posts the target when lookup finds the attempt', async () => {
    const logPath = join(directory, `found-${crypto.randomUUID()}.log`);
    const targetId = await createTarget();

    // The state a crash in the dangerous window leaves behind: the platform has the
    // post, the database does not know. Built directly rather than by dispatching
    // and rewinding, because `posted -> dispatching` is an illegal transition and
    // the guard trigger is right to refuse it.
    await sql`
      update poster.post_targets
         set state = 'dispatching', claimed_by = 'dead-worker',
             claim_expires_at = now() - interval '1 second', attempt_count = 1
       where id = ${targetId}`;
    const attempts = await sql<{ id: string }[]>`
      insert into poster.dispatch_attempts (target_id, attempt_no, worker_id, adapter, outcome)
      values (${targetId}, 1, 'dead-worker', 'chaos', 'in_flight')
      returning id`;
    // The "platform" recorded this attempt, so lookup will find it.
    const { appendFileSync } = await import('node:fs');
    appendFileSync(logPath, `${attempts[0]?.id as string}\t${targetId}\n`);

    const result = await reconcileTick(reconcileConfig, deps(logPath));
    expect(result.posted).toBe(1);

    const rows = await sql<{ state: string; needs_reconciliation: boolean }[]>`
      select state, needs_reconciliation from poster.post_targets where id = ${targetId}`;
    expect(rows[0]?.state).toBe('posted');
    expect(rows[0]?.needs_reconciliation).toBe(false);
    // And it was not sent a second time.
    expect(publishCountFor(logPath, targetId)).toBe(1);
  });

  it('retries the target when lookup proves it was never sent', async () => {
    const logPath = join(directory, `absent-${crypto.randomUUID()}.log`);
    const targetId = await createTarget();

    // Claimed, attempt row written, then died before the adapter sent anything.
    await sql`
      update poster.post_targets
         set state = 'dispatching', claimed_by = 'dead-worker',
             claim_expires_at = now() - interval '1 second', attempt_count = 1
       where id = ${targetId}`;
    await sql`
      insert into poster.dispatch_attempts (target_id, attempt_no, worker_id, adapter, outcome)
      values (${targetId}, 1, 'dead-worker', 'chaos', 'in_flight')`;

    const result = await reconcileTick(reconcileConfig, deps(logPath));
    expect(result.retried).toBe(1);

    const rows = await sql<{ state: string }[]>`
      select state from poster.post_targets where id = ${targetId}`;
    // Back to scheduled: absent is the only answer that makes a retry safe.
    expect(rows[0]?.state).toBe('scheduled');
  });

  it('fails the target dispatch_outcome_unknown when lookup cannot tell', async () => {
    const logPath = join(directory, `unknown-${crypto.randomUUID()}.log`);
    const targetId = await createTarget();

    await sql`
      update poster.post_targets
         set state = 'dispatching', claimed_by = 'dead-worker',
             claim_expires_at = now() - interval '1 second', attempt_count = 1
       where id = ${targetId}`;
    await sql`
      insert into poster.dispatch_attempts (target_id, attempt_no, worker_id, adapter, outcome)
      values (${targetId}, 1, 'dead-worker', 'chaos', 'in_flight')`;

    const result = await reconcileTick(reconcileConfig, deps(logPath, 'unknown'));
    expect(result.failedUnknown).toBe(1);

    const rows = await sql<{ state: string; reason_class: string | null }[]>`
      select state, reason_class from poster.post_targets where id = ${targetId}`;
    // A rare visible failure beats a silent duplicate (contract §6).
    expect(rows[0]?.state).toBe('failed');
    expect(rows[0]?.reason_class).toBe('dispatch_outcome_unknown');
  });

  it('retries when there is no attempt row at all, because rule 4 means nothing was sent', async () => {
    const logPath = join(directory, `noattempt-${crypto.randomUUID()}.log`);
    const targetId = await createTarget();

    // Died between the claim and the attempt-row insert. Rule 4 guarantees the row
    // precedes any adapter call, so its absence proves nothing reached the platform.
    await sql`
      update poster.post_targets
         set state = 'dispatching', claimed_by = 'dead-worker',
             claim_expires_at = now() - interval '1 second', attempt_count = 1
       where id = ${targetId}`;

    const result = await reconcileTick(reconcileConfig, deps(logPath));
    expect(result.retried).toBe(1);
    const rows = await sql<{ state: string }[]>`
      select state from poster.post_targets where id = ${targetId}`;
    expect(rows[0]?.state).toBe('scheduled');
  });

  it('picks up a target it flagged but did not finish resolving', async () => {
    const logPath = join(directory, `stuck-${crypto.randomUUID()}.log`);
    const targetId = await createTarget();

    // Already flagged, so mark_stale_dispatches will never return it again. If the
    // reconciler only looked at what it just flagged, this row would be stuck.
    await sql`
      update poster.post_targets
         set state = 'dispatching', claimed_by = 'dead-worker',
             claim_expires_at = now() - interval '1 minute', attempt_count = 1,
             needs_reconciliation = true
       where id = ${targetId}`;

    const result = await reconcileTick(reconcileConfig, deps(logPath));
    expect(result.flagged).toBe(0);
    expect(result.examined).toBe(1);

    const rows = await sql<{ state: string }[]>`
      select state from poster.post_targets where id = ${targetId}`;
    expect(rows[0]?.state).not.toBe('dispatching');
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 1: 100 chaos runs, zero double-posts
// ---------------------------------------------------------------------------
describe('chaos: SIGKILL around the adapter call (criterion 1)', () => {
  it('produces zero double-posts across 100 runs', async () => {
    const logPath = join(directory, 'chaos-publishes.log');
    const targets: { targetId: string; mode: string }[] = [];
    let killed = 0;
    const reconciled = { posted: 0, retried: 0, failedUnknown: 0 };

    // A spread of crash points. `after_send` is the dangerous one: the platform
    // has the post but the database does not, so a wrong reconciliation duplicates
    // it. `race` kills on an unpredictable delay, covering the windows the adapter
    // itself cannot reach (after the claim, around the attempt-row insert, and
    // just before finish_dispatch).
    const modes = ['after_send', 'before_send', 'race', 'none'] as const;

    for (let run = 0; run < RUNS; run += 1) {
      const mode = modes[run % modes.length] as (typeof modes)[number];
      const targetId = await createTarget();
      targets.push({ targetId, mode });

      const args = [
        '--master-key',
        MASTER_KEY,
        '--platform',
        'tiktok',
        '--log',
        logPath,
        '--worker',
        `chaos-${String(run)}`,
        '--crash-at',
        mode === 'after_send' || mode === 'before_send' ? mode : 'none',
      ];
      if (mode === 'race') {
        // Short and jittery, so kills land in different places across runs.
        args.push('--race-ms', String(2 + Math.floor(Math.random() * 40)));
      }

      const ended = await runChild(args);
      if (ended.signal === 'SIGKILL' || ended.code === 137) killed += 1;

      // Time passes: the dead worker's lease expires.
      await expireLease(targetId);
    }

    // Guard against a vacuous pass. "100 targets posted, none twice" would also be
    // true if no child ever actually died, which is the one way this test could
    // look green while proving nothing.
    // eslint-disable-next-line no-console
    console.log(`chaos: ${String(killed)} of ${String(RUNS)} children were SIGKILLed`);
    expect(killed, 'no child actually crashed; the test would be vacuous').toBeGreaterThanOrEqual(
      RUNS / 2,
    );

    // Now let reconciliation resolve everything the crashes left behind. Looping
    // because a retried target becomes claimable again and may need dispatching.
    const adapter = createChaosAdapter({ publishLogPath: logPath });
    const registry = createAdapterRegistry([adapter]);
    const deps = {
      sql,
      vault,
      adapterFor: (platformId: string) => registry.for(platformId),
      logger: silent,
      workerId: 'chaos-reconciler',
    };

    for (let pass = 0; pass < 30; pass += 1) {
      const result = await reconcileTick(reconcileConfig, deps);
      reconciled.posted += result.posted;
      reconciled.retried += result.retried;
      reconciled.failedUnknown += result.failedUnknown;

      // A reconciled retry comes back as `scheduled` with a 30 second backoff.
      // The criterion permits leaving targets there, but draining them is stronger
      // evidence: it shows each one ends somewhere final. Time passes by fiat.
      await sql`
        update poster.post_targets set next_attempt_at = null
         where user_id = ${ids.user} and state = 'scheduled'`;

      await dispatchTick(
        {
          platformId: 'tiktok',
          concurrency: 8,
          pollIntervalMs: 20,
          leaseMs: 60_000,
          publishTimeoutMs: 5_000,
        },
        deps,
      );

      // Anything the tick left dispatching had no crash to explain it, but expiring
      // the lease keeps the loop from stalling on a slow round trip.
      await sql`
        update poster.post_targets set claim_expires_at = now() - interval '1 second'
         where user_id = ${ids.user} and state = 'dispatching'`;

      const pending = await sql<{ n: string }[]>`
        select count(*) as n from poster.post_targets
         where user_id = ${ids.user} and state in ('scheduled', 'dispatching')`;
      if (Number(pending[0]?.n ?? 0) === 0) break;
    }

    // --- the invariant --------------------------------------------------
    const log = readPublishLog(logPath);
    const byTarget = new Map<string, number>();
    for (const record of log) {
      byTarget.set(record.targetId, (byTarget.get(record.targetId) ?? 0) + 1);
    }

    const duplicated = [...byTarget.entries()].filter(([, count]) => count > 1);
    // eslint-disable-next-line no-console
    console.log(
      `chaos: ${String(RUNS)} runs, ${String(log.length)} publishes across ` +
        `${String(byTarget.size)} targets, ${String(duplicated.length)} duplicated`,
    );

    expect(
      duplicated,
      `targets published more than once: ${duplicated.map(([id, n]) => `${id}=${String(n)}`).join(', ')}`,
    ).toEqual([]);

    // --- criterion 2: nothing left in dispatching ------------------------
    // Scoped to the targets this test created. The earlier reconciler-branch tests
    // share the user, and the drain loop above swept their leftovers in too, which
    // is why the publish log holds more than RUNS entries: the no-duplicate
    // invariant is global, but the arithmetic below should not be.
    const chaosTargetIds = targets.map((entry) => entry.targetId);
    const states = await sql<{ state: string; n: string }[]>`
      select state::text as state, count(*) as n from poster.post_targets
       where id = any(${sql.array(chaosTargetIds)}::uuid[])
       group by state order by state`;
    // eslint-disable-next-line no-console
    console.log(`chaos: final states ${states.map((row) => `${row.state}=${row.n}`).join(' ')}`);

    const stuck = states.find((row) => row.state === 'dispatching');
    expect(stuck, `targets stuck in dispatching: ${stuck?.n ?? '0'}`).toBeUndefined();

    // The criterion allows a terminal state *or* scheduled (a pending retry). The
    // drain loop above means these should all be terminal, but `scheduled` is
    // permitted rather than treated as a failure, because it is not stuck.
    const allowed = new Set(['posted', 'failed', 'canceled', 'scheduled']);
    for (const row of states) {
      expect(allowed.has(row.state), `unexpected final state ${row.state}`).toBe(true);
    }

    expect(
      states.reduce((sum, row) => sum + Number(row.n), 0),
      'every chaos target should be accounted for',
    ).toBe(RUNS);

    // And reconciliation did real work, rather than the crashes happening to land
    // somewhere harmless every time.
    // eslint-disable-next-line no-console
    console.log(
      `chaos: reconciler posted ${String(reconciled.posted)}, retried ${String(reconciled.retried)}, ` +
        `failed-unknown ${String(reconciled.failedUnknown)}`,
    );
    expect(
      reconciled.posted + reconciled.retried,
      'reconciliation never resolved anything, so the crashes were not in a window that mattered',
    ).toBeGreaterThan(0);
    // The dangerous window specifically: a crash after the platform had the post.
    // If this were zero, the duplicate-free result would not mean much.
    expect(
      reconciled.posted,
      'no crash landed after the publish, which is the window duplicates come from',
    ).toBeGreaterThan(0);

    // Each chaos target published exactly once: none lost, none duplicated.
    for (const { targetId, mode } of targets) {
      const count = publishCountFor(logPath, targetId);
      expect(count, `target ${targetId} (${mode}) published ${String(count)} times`).toBe(1);
    }
  }, 600_000);
});

// ---------------------------------------------------------------------------
// Acceptance criterion 2, timing half: the bound is lease + one tick.
// ---------------------------------------------------------------------------
describe('nothing stays in dispatching beyond lease plus a tick (criterion 2)', () => {
  it('resolves a crashed dispatch without anyone expiring the lease by hand', async () => {
    const logPath = join(directory, `timed-${crypto.randomUUID()}.log`);
    const targetId = await createTarget();
    const leaseMs = 1_500;

    // A real short lease, and no manual expiry: the only thing that resolves this
    // target is the lease genuinely running out and the reconciler noticing.
    await sql`
      update poster.post_targets
         set state = 'dispatching', claimed_by = 'dead-worker',
             claim_expires_at = now() + ${`${String(leaseMs)} milliseconds`}::interval,
             attempt_count = 1
       where id = ${targetId}`;
    await sql`
      insert into poster.dispatch_attempts (target_id, attempt_no, worker_id, adapter, outcome)
      values (${targetId}, 1, 'dead-worker', 'chaos', 'in_flight')`;

    const adapter = createChaosAdapter({ publishLogPath: logPath });
    const registry = createAdapterRegistry([adapter]);
    const pollIntervalMs = 250;

    const stopping = new AbortController();
    const started = Date.now();
    const loop = startReconcileLoop(
      { batchSize: 10, pollIntervalMs, lookupTimeoutMs: 2_000 },
      {
        sql,
        vault,
        adapterFor: (platformId: string) => registry.for(platformId),
        logger: silent,
      },
      stopping.signal,
    );

    let resolvedMs = Number.NaN;
    for (let i = 0; i < 200; i += 1) {
      const rows = await sql<{ state: string }[]>`
        select state from poster.post_targets where id = ${targetId}`;
      if (rows[0]?.state !== 'dispatching') {
        resolvedMs = Date.now() - started;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    stopping.abort();
    await loop.done;

    expect(Number.isNaN(resolvedMs), 'target never left dispatching').toBe(false);
    // The documented bound: the lease, plus at most one reconciler tick, plus
    // slack for the round trips.
    const bound = leaseMs + pollIntervalMs + 1_000;
    // eslint-disable-next-line no-console
    console.log(
      `chaos: stale dispatch resolved in ${String(resolvedMs)}ms (bound ${String(bound)}ms)`,
    );
    expect(resolvedMs).toBeLessThan(bound);
  }, 60_000);
});
