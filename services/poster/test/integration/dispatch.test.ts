/**
 * The dispatcher against a real database (S06 acceptance criteria).
 *
 * All four criteria are properties of the claim/finish functions plus real
 * concurrency, so none of them can be shown with a fake database: the retry
 * sequence is `finish_dispatch`'s backoff arithmetic, the isolation claim is about
 * two loops actually running at once, and the p95 measurement is meaningless
 * without real round trips.
 *
 * Requires a running local stack (`pnpm exec supabase start`).
 */
import { randomBytes } from 'node:crypto';
import { createLocalKeyManager } from '@suite/server-core';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createFakeAdapter, type FakeAdapter } from '../../src/adapters/fake.js';
import { createAdapterRegistry } from '../../src/adapters/registry.js';
import { createCredentialVault, type CredentialVault } from '../../src/vault/credentials.js';
import {
  dispatchTick,
  startDispatchLoop,
  type DispatchDeps,
  type PlatformDispatchConfig,
} from '../../src/worker/dispatch-loop.js';
import { loadDispatchablePlatforms } from '../../src/worker/platforms.js';
import { loadConstraints, readSpecs, specDirectory } from '../../src/seed-constraints.js';
import { TEST_CLIENT_ID, seed } from '../../src/seed.js';

const DATABASE_URL =
  process.env['POSTER_TEST_DATABASE_URL'] ??
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const repoRoot = process.cwd().replace(/\/services\/poster$/, '');

const ids = {
  user: crypto.randomUUID(),
  tiktok: crypto.randomUUID(),
  youtube: crypto.randomUUID(),
};

const sql = postgres(DATABASE_URL, { max: 24, onnotice: () => {} });
const keys = createLocalKeyManager({ masterKeyBase64: randomBytes(32).toString('base64') });

let vault: CredentialVault;
let credentialId = '';
let appId = '';
let reachable = false;
let adapter: FakeAdapter;
let deps: DispatchDeps;

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function config(over: Partial<PlatformDispatchConfig> = {}): PlatformDispatchConfig {
  return {
    platformId: 'tiktok',
    concurrency: 8,
    pollIntervalMs: 20,
    leaseMs: 60_000,
    publishTimeoutMs: 5_000,
    ...over,
  };
}

async function cleanup(): Promise<void> {
  await sql`delete from poster.posts where user_id = ${ids.user}`;
  await sql`delete from poster.connections where user_id = ${ids.user}`;
  await sql`delete from poster.credentials where user_id = ${ids.user}`;
  await sql`delete from auth.users where id = ${ids.user}`;
}

/** Creates one post with one target per platform given, due in the past. */
async function createTargets(
  platforms: readonly ('tiktok' | 'youtube')[],
  options: { dueAt?: Date } = {},
): Promise<string[]> {
  const postRows = await sql<{ id: string }[]>`
    insert into poster.posts (user_id, app_id, content)
    values (${ids.user}, ${appId}, ${sql.json({ text: 'dispatch me' } as never)})
    returning id`;
  const postId = postRows[0]?.id as string;

  const created: string[] = [];
  for (const [position, platform] of platforms.entries()) {
    const rows = await sql<{ id: string }[]>`
      insert into poster.post_targets
        (post_id, user_id, connection_id, platform_id, position, due_at, state)
      values (${postId}, ${ids.user},
              ${platform === 'tiktok' ? ids.tiktok : ids.youtube}, ${platform},
              ${position}, ${options.dueAt ?? new Date(Date.now() - 60_000)}, 'scheduled')
      returning id`;
    created.push(rows[0]?.id as string);
  }
  return created;
}

async function targetRow(targetId: string) {
  const rows = await sql<
    {
      state: string;
      attempt_count: number;
      reason_class: string | null;
      platform_message: string | null;
      permalink: string | null;
      platform_post_id: string | null;
      next_attempt_at: Date | null;
      posted_at: Date | null;
      due_at: Date;
      claimed_by: string | null;
    }[]
  >`select state, attempt_count, reason_class, platform_message, permalink, platform_post_id,
           next_attempt_at, posted_at, due_at, claimed_by
      from poster.post_targets where id = ${targetId}`;
  return rows[0];
}

beforeAll(async () => {
  try {
    await sql`select 1`;
    reachable = true;
  } catch {
    return;
  }

  await cleanup();
  await seed(DATABASE_URL);
  await loadConstraints(DATABASE_URL, readSpecs(specDirectory(repoRoot)));

  const apps = await sql<{ id: string }[]>`
    select id from poster.client_apps where client_id = ${TEST_CLIENT_ID}`;
  appId = apps[0]?.id as string;

  await sql`
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
    values (${ids.user}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`dispatch-${ids.user}@example.test`}, 'x', now(), now())`;

  vault = createCredentialVault(sql, keys);
  // A real encrypted credential, so the dispatcher's decrypt path is exercised
  // rather than stubbed (rule 5).
  credentialId = await vault.store({
    userId: ids.user,
    kind: 'aggregator_profile',
    provider: 'fake',
    secret: 'aggregator-profile-key-do-not-log',
  });

  await sql`
    insert into poster.connections (id, user_id, platform_id, credential_id, external_account_id) values
      (${ids.tiktok},  ${ids.user}, 'tiktok',  ${credentialId}, ${`tt-${ids.tiktok}`}),
      (${ids.youtube}, ${ids.user}, 'youtube', ${credentialId}, ${`yt-${ids.youtube}`})`;

  adapter = createFakeAdapter();
  const registry = createAdapterRegistry([adapter]);
  deps = {
    sql,
    vault,
    adapterFor: (platformId) => registry.for(platformId),
    workerId: 'itest-worker',
    logger: silentLogger,
  };
});

afterEach(async () => {
  if (reachable) {
    await sql`delete from poster.posts where user_id = ${ids.user}`;
    adapter.reset();
  }
});

afterAll(async () => {
  if (reachable) await cleanup();
  await sql.end({ timeout: 5 });
});

describe('environment', () => {
  it('has a reachable database', () => {
    expect(reachable, `need a local stack for ${DATABASE_URL}`).toBe(true);
  });
});

describe('a plain dispatch', () => {
  it('claims, publishes and posts the target', async () => {
    const [targetId] = await createTargets(['tiktok']);
    const result = await dispatchTick(config(), deps);

    expect(result).toEqual({ claimed: 1, resolved: 1, fencedOut: 0 });

    const row = await targetRow(targetId as string);
    expect(row?.state).toBe('posted');
    expect(row?.permalink).toContain(targetId as string);
    expect(row?.platform_post_id).toBeTruthy();
    expect(row?.posted_at).not.toBeNull();
    // Leaving dispatching drops the claim, so no lease outlives the flight.
    expect(row?.claimed_by).toBeNull();
  });

  it('writes the attempt row before calling the adapter (rule 4)', async () => {
    const [targetId] = await createTargets(['tiktok']);
    await dispatchTick(config(), deps);

    const attempts = await sql<
      { id: string; outcome: string; adapter: string; worker_id: string }[]
    >`
      select id, outcome, adapter, worker_id from poster.dispatch_attempts
       where target_id = ${targetId as string}`;

    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe('success');
    expect(attempts[0]?.adapter).toBe('fake');
    expect(attempts[0]?.worker_id).toBe('itest-worker');
    // The attempt id is what was handed to the provider as its reference (D-012).
    expect(adapter.attemptRefs).toContain(attempts[0]?.id);
  });

  it('logs every credential decrypt, attributed to the platform and target', async () => {
    const [targetId] = await createTargets(['tiktok']);
    await dispatchTick(config(), deps);

    const log = await sql<{ accessor: string; purpose: string; target_id: string | null }[]>`
      select accessor, purpose, target_id from poster.vault_access_log
       where credential_id = ${credentialId} order by accessed_at desc limit 1`;

    expect(log[0]).toMatchObject({
      accessor: 'dispatcher:tiktok',
      purpose: 'dispatch',
      target_id: targetId,
    });
  });

  it('never re-dispatches a row already in dispatching (rule 3)', async () => {
    const [targetId] = await createTargets(['tiktok']);
    await sql`
      update poster.post_targets
         set state = 'dispatching', claimed_by = 'someone-else',
             claim_expires_at = now() + interval '5 minutes'
       where id = ${targetId as string}`;

    const result = await dispatchTick(config(), deps);
    expect(result.claimed).toBe(0);
    expect(adapter.publishCount(targetId as string)).toBe(0);
  });

  it('claims nothing for a platform with no due work', async () => {
    expect(await dispatchTick(config(), deps)).toEqual({ claimed: 0, resolved: 0, fencedOut: 0 });
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 1: transient x2 then success
// ---------------------------------------------------------------------------
describe('transient retries (criterion 1)', () => {
  it('yields posted with 3 attempts and the documented backoff', async () => {
    const [targetId] = await createTargets(['tiktok']);
    const target = targetId as string;
    adapter.script(target, {
      steps: [{ kind: 'transient' }, { kind: 'transient' }, { kind: 'success' }],
    });

    // --- attempt 1 -------------------------------------------------------
    await dispatchTick(config(), deps);
    let row = await targetRow(target);
    expect(row?.state).toBe('scheduled');
    expect(row?.attempt_count).toBe(1);

    // finish_dispatch backs off 30s * 2^(attempt-1): 30s after the first failure.
    const firstBackoffS = (row?.next_attempt_at as Date).getTime() / 1000 - Date.now() / 1000;
    expect(firstBackoffS).toBeGreaterThan(25);
    expect(firstBackoffS).toBeLessThan(35);

    // The retry is genuinely held back: a tick now claims nothing.
    expect((await dispatchTick(config(), deps)).claimed).toBe(0);

    // Fast-forward rather than waiting 30 real seconds. The value was asserted
    // above; what this proves is that the loop respects it.
    await sql`update poster.post_targets set next_attempt_at = now() where id = ${target}`;

    // --- attempt 2 -------------------------------------------------------
    await dispatchTick(config(), deps);
    row = await targetRow(target);
    expect(row?.state).toBe('scheduled');
    expect(row?.attempt_count).toBe(2);

    const secondBackoffS = (row?.next_attempt_at as Date).getTime() / 1000 - Date.now() / 1000;
    expect(secondBackoffS).toBeGreaterThan(55);
    expect(secondBackoffS).toBeLessThan(65);
    expect(secondBackoffS).toBeGreaterThan(firstBackoffS);

    await sql`update poster.post_targets set next_attempt_at = now() where id = ${target}`;

    // --- attempt 3 -------------------------------------------------------
    await dispatchTick(config(), deps);
    row = await targetRow(target);
    expect(row?.state).toBe('posted');
    expect(row?.attempt_count).toBe(3);

    const attempts = await sql<{ attempt_no: number; outcome: string }[]>`
      select attempt_no, outcome from poster.dispatch_attempts
       where target_id = ${target} order by attempt_no`;
    expect(attempts).toEqual([
      { attempt_no: 1, outcome: 'transient' },
      { attempt_no: 2, outcome: 'transient' },
      { attempt_no: 3, outcome: 'success' },
    ]);

    // Posted exactly once, however many attempts it took (NFR-02).
    expect(adapter.publishCount(target)).toBe(1);
  });

  it('honours a provider retryAt in preference to the default backoff', async () => {
    const [targetId] = await createTargets(['tiktok']);
    adapter.script(targetId as string, {
      steps: [{ kind: 'transient', retryAfterMs: 5_000 }],
    });

    await dispatchTick(config(), deps);
    const row = await targetRow(targetId as string);
    const backoffS = (row?.next_attempt_at as Date).getTime() / 1000 - Date.now() / 1000;
    // 5s from the provider, not the 30s default: a Retry-After is information.
    expect(backoffS).toBeLessThan(10);
  });

  it('fails as transient_exhausted once the attempts run out', async () => {
    const [targetId] = await createTargets(['tiktok']);
    const target = targetId as string;
    await sql`update poster.post_targets set max_attempts = 2 where id = ${target}`;
    adapter.script(target, { steps: [{ kind: 'transient', message: 'upstream flaky' }] });

    await dispatchTick(config(), deps);
    await sql`update poster.post_targets set next_attempt_at = now() where id = ${target}`;
    await dispatchTick(config(), deps);

    const row = await targetRow(target);
    expect(row?.state).toBe('failed');
    expect(row?.reason_class).toBe('transient_exhausted');
    expect(row?.platform_message).toBe('upstream flaky');
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 2: permanent
// ---------------------------------------------------------------------------
describe('permanent rejection (criterion 2)', () => {
  it('yields failed/platform_rejected carrying the platform message', async () => {
    const [targetId] = await createTargets(['tiktok']);
    const target = targetId as string;
    adapter.script(target, {
      steps: [{ kind: 'permanent', message: 'Caption exceeds 2200 characters' }],
    });

    await dispatchTick(config(), deps);

    const row = await targetRow(target);
    expect(row?.state).toBe('failed');
    expect(row?.reason_class).toBe('platform_rejected');
    expect(row?.platform_message).toBe('Caption exceeds 2200 characters');
    expect(row?.attempt_count).toBe(1);
    // Not retried: a permanent rejection will fail identically next time.
    expect((await dispatchTick(config(), deps)).claimed).toBe(0);
  });

  it('emits a post.failed event carrying the reason class', async () => {
    const [targetId] = await createTargets(['tiktok']);
    adapter.script(targetId as string, { steps: [{ kind: 'permanent', message: 'nope' }] });
    await dispatchTick(config(), deps);

    const events = await sql<{ type: string; payload: { data: { reason_class: string } } }[]>`
      select type, payload from poster.webhook_events
       where target_id = ${targetId as string} and type = 'post.failed'`;
    expect(events[0]?.payload.data.reason_class).toBe('platform_rejected');
  });
});

describe('an ambiguous outcome', () => {
  it('holds the target in dispatching for reconciliation rather than retrying', async () => {
    const [targetId] = await createTargets(['tiktok']);
    const target = targetId as string;
    adapter.script(target, { steps: [{ kind: 'unknown', message: 'connection reset' }] });

    await dispatchTick(config(), deps);

    const row = await targetRow(target);
    // Not scheduled: retrying could double-post. Not failed: it may have landed.
    expect(row?.state).toBe('dispatching');
    const flagged = await sql<{ needs_reconciliation: boolean }[]>`
      select needs_reconciliation from poster.post_targets where id = ${target}`;
    expect(flagged[0]?.needs_reconciliation).toBe(true);
  });

  it('treats a publish that hangs past its deadline as unknown', async () => {
    const [targetId] = await createTargets(['tiktok']);
    const target = targetId as string;
    adapter.script(target, { steps: [{ kind: 'hang' }] });

    await dispatchTick(config({ publishTimeoutMs: 150 }), deps);

    const row = await targetRow(target);
    expect(row?.state).toBe('dispatching');
    expect(adapter.publishCount(target)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 3: platform isolation
// ---------------------------------------------------------------------------
describe('platform isolation (criterion 3, rule 10)', () => {
  it('a hung TikTok publish does not delay YouTube posts', async () => {
    // One TikTok target that wedges for longer than the whole measurement, and
    // one YouTube target that should sail past it.
    const [tiktokTarget] = await createTargets(['tiktok']);
    const [youtubeTarget] = await createTargets(['youtube']);
    adapter.script(tiktokTarget as string, { steps: [{ kind: 'hang' }] });

    const stopping = new AbortController();
    const started = Date.now();

    const tiktokLoop = startDispatchLoop(
      config({ platformId: 'tiktok', concurrency: 1, publishTimeoutMs: 10_000 }),
      deps,
      stopping.signal,
    );
    const youtubeLoop = startDispatchLoop(
      config({ platformId: 'youtube', concurrency: 4 }),
      deps,
      stopping.signal,
    );

    // Wait for YouTube to finish, polling rather than sleeping a fixed time.
    let youtubeMs = Number.NaN;
    for (let i = 0; i < 100; i += 1) {
      const row = await targetRow(youtubeTarget as string);
      if (row?.state === 'posted') {
        youtubeMs = Date.now() - started;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const tiktokRow = await targetRow(tiktokTarget as string);
    stopping.abort();
    await Promise.all([tiktokLoop.done, youtubeLoop.done]);

    expect(Number.isNaN(youtubeMs), 'YouTube never posted').toBe(false);
    // The TikTok publish is still wedged, and YouTube finished in well under a
    // second. The measurement is the point: isolation is a number, not a claim.
    expect(tiktokRow?.state).toBe('dispatching');
    expect(youtubeMs, `YouTube took ${String(youtubeMs)}ms while TikTok was hung`).toBeLessThan(
      2_000,
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Acceptance criterion 4: p95 dispatch lag
// ---------------------------------------------------------------------------
describe('dispatch lag (criterion 4)', () => {
  it('keeps p95 lag under 60s for 500 targets due in the same minute', async () => {
    const TOTAL = 500;
    // All due at the same instant, as a minute's worth of scheduled posts would be.
    const dueAt = new Date();

    const postRows = await sql<{ id: string }[]>`
      insert into poster.posts (user_id, app_id, content)
      select ${ids.user}, ${appId}, ${sql.json({ text: 'load' } as never)}
        from generate_series(1, ${TOTAL})
      returning id`;

    await sql`
      insert into poster.post_targets
        (post_id, user_id, connection_id, platform_id, position, due_at, state)
      select p.id, ${ids.user}, ${ids.tiktok}, 'tiktok', 0, ${dueAt}, 'scheduled'
        from unnest(${sql.array(postRows.map((row) => row.id))}::uuid[]) as p(id)`;

    const stopping = new AbortController();
    const loop = startDispatchLoop(
      config({ platformId: 'tiktok', concurrency: 16, pollIntervalMs: 20 }),
      deps,
      stopping.signal,
    );

    const deadline = Date.now() + 120_000;
    let posted = 0;
    while (Date.now() < deadline) {
      const rows = await sql<{ n: string }[]>`
        select count(*) as n from poster.post_targets
         where user_id = ${ids.user} and state = 'posted'`;
      posted = Number(rows[0]?.n ?? 0);
      if (posted >= TOTAL) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    stopping.abort();
    await loop.done;

    expect(posted, 'not every target posted within the measurement window').toBe(TOTAL);

    // Lag is posted_at - due_at, measured in the database to avoid clock skew.
    const lag = await sql<{ p95: number; max: number; median: number }[]>`
      select
        percentile_disc(0.95) within group (order by extract(epoch from (posted_at - due_at))) as p95,
        max(extract(epoch from (posted_at - due_at))) as max,
        percentile_disc(0.5) within group (order by extract(epoch from (posted_at - due_at))) as median
      from poster.post_targets
      where user_id = ${ids.user} and state = 'posted'`;

    const p95 = Number(lag[0]?.p95);
    console.log(
      `dispatch lag over ${String(TOTAL)} targets: median ${String(lag[0]?.median)}s, ` +
        `p95 ${String(p95)}s, max ${String(lag[0]?.max)}s`,
    );

    expect(p95).toBeLessThan(60);
    // Nothing early either (NFR-01): a negative lag would mean dispatching before due.
    expect(Number(lag[0]?.median)).toBeGreaterThanOrEqual(0);
  }, 180_000);
});

describe('loadDispatchablePlatforms', () => {
  it('returns only enabled platforms that have a constraint spec', async () => {
    const platforms = await loadDispatchablePlatforms(sql, {
      concurrency: 8,
      pollIntervalMs: 1000,
      leaseMs: 60_000,
      publishTimeoutMs: 5_000,
    });

    expect(platforms.map((platform) => platform.platformId).sort()).toEqual(['tiktok', 'youtube']);
  });

  it('applies a per-platform override without touching the others (rule 10)', async () => {
    const platforms = await loadDispatchablePlatforms(
      sql,
      { concurrency: 8, pollIntervalMs: 1000, leaseMs: 60_000, publishTimeoutMs: 5_000 },
      { tiktok: { concurrency: 2 } },
    );

    const byId = new Map(platforms.map((platform) => [platform.platformId, platform]));
    expect(byId.get('tiktok')?.concurrency).toBe(2);
    expect(byId.get('youtube')?.concurrency).toBe(8);
  });
});
