/**
 * Concurrent dispatch claims must return disjoint rows.
 *
 * This is the one S02 invariant that pgTAP cannot prove. `for update skip
 * locked` only means something when a second session contends for the same rows
 * while the first has them locked and uncommitted, and a pgTAP file is a single
 * session inside one rolled-back transaction. dblink would give a second
 * session, but Supabase's local pg_hba trusts 127.0.0.1, so no password is
 * exchanged and dblink refuses to connect as a non-superuser (D-039).
 *
 * So: two real connections, one holding an open transaction while the other
 * claims. Requires a running local Supabase (`pnpm exec supabase start`).
 */
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DATABASE_URL =
  process.env['POSTER_TEST_DATABASE_URL'] ??
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const TARGET_COUNT = 10;

/** Unique per run so a failed run cannot poison the next one. */
const ids = {
  user: crypto.randomUUID(),
  app: crypto.randomUUID(),
  credential: crypto.randomUUID(),
  connection: crypto.randomUUID(),
};

// max 3: the contention tests reserve two dedicated connections at once and
// still need one free for setup and assertions.
const admin = postgres(DATABASE_URL, { max: 3, onnotice: () => {} });

async function seed(): Promise<void> {
  await admin`
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
    values (${ids.user}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`claim-${ids.user}@example.test`}, 'x', now(), now())`;

  await admin`
    insert into poster.client_apps (id, client_id, name, client_secret_hash)
    values (${ids.app}, ${`claim-test-${ids.app}`}, 'Claim Concurrency Test', 'argon2id-placeholder')`;

  await admin`
    insert into poster.credentials (id, user_id, kind, provider, ciphertext, wrapped_dek, kms_key_id, nonce)
    values (${ids.credential}, ${ids.user}, 'aggregator_profile', 'ayrshare',
            '\\x01', '\\x02', 'kms-test', '\\x03')`;

  await admin`
    insert into poster.connections (id, user_id, platform_id, credential_id, external_account_id)
    values (${ids.connection}, ${ids.user}, 'tiktok', ${ids.credential}, ${`tt-${ids.connection}`})`;

  // One post per target: post_targets is unique per (post, connection).
  for (let i = 0; i < TARGET_COUNT; i += 1) {
    const postId = crypto.randomUUID();
    await admin`
      insert into poster.posts (id, user_id, app_id, content)
      values (${postId}, ${ids.user}, ${ids.app}, ${admin.json({ text: `concurrent ${i}` })})`;
    await admin`
      insert into poster.post_targets
        (post_id, user_id, connection_id, platform_id, position, due_at, state)
      values (${postId}, ${ids.user}, ${ids.connection}, 'tiktok', 0,
              now() - interval '1 minute', 'scheduled')`;
  }
}

async function cleanup(): Promise<void> {
  // Order matters. post_targets -> connections is deliberately NOT cascading
  // (a connection must not be deletable out from under queued work), so deleting
  // the user first cascades into connections and trips that FK. Remove the posts
  // — which cascade to their targets — before the connections they point at.
  await admin`delete from poster.webhook_events where app_id = ${ids.app}`;
  await admin`delete from poster.posts where user_id = ${ids.user}`;
  await admin`delete from poster.connections where user_id = ${ids.user}`;
  await admin`delete from poster.credentials where user_id = ${ids.user}`;
  await admin`delete from auth.users where id = ${ids.user}`;
  await admin`delete from poster.client_apps where id = ${ids.app}`;
}

let databaseReachable = false;

beforeAll(async () => {
  try {
    await admin`select 1`;
    databaseReachable = true;
  } catch {
    return;
  }
  await cleanup();
  await seed();
});

afterAll(async () => {
  if (databaseReachable) await cleanup();
  await admin.end({ timeout: 5 });
});

describe('poster.claim_due_targets under contention', () => {
  it('the local database is reachable', () => {
    expect(
      databaseReachable,
      `cannot reach ${DATABASE_URL} — run \`pnpm exec supabase start\` first`,
    ).toBe(true);
  });

  it('hands each due target to exactly one of two concurrent workers', async () => {
    const a = await admin.reserve();
    const b = await admin.reserve();

    try {
      // Worker A claims half and holds the transaction open, exactly as a worker
      // does while it is talking to a platform adapter.
      await a.unsafe('begin');
      const claimedA = await a<{ id: string }[]>`
        select id from poster.claim_due_targets('tiktok', 'worker-a', 5)`;

      // Worker B contends while A's rows are still locked and uncommitted.
      await b.unsafe('begin');
      const claimedB = await b<{ id: string }[]>`
        select id from poster.claim_due_targets('tiktok', 'worker-b', 5)`;

      const idsA = claimedA.map((row) => row.id);
      const idsB = claimedB.map((row) => row.id);

      expect(idsA).toHaveLength(5);
      expect(idsB).toHaveLength(5);

      const overlap = idsA.filter((id) => idsB.includes(id));
      expect(overlap, 'the same target was claimed by both workers').toEqual([]);

      expect(new Set([...idsA, ...idsB]).size).toBe(TARGET_COUNT);

      await a.unsafe('rollback');
      await b.unsafe('rollback');
    } finally {
      await a.release();
      await b.release();
    }
  });

  it('leaves a contending worker empty-handed when one worker takes everything', async () => {
    const a = await admin.reserve();
    const b = await admin.reserve();

    try {
      // Drain rather than claim exactly TARGET_COUNT: the assertion below is
      // "B gets nothing", which only holds if A took everything that was due.
      // A fixed limit would silently pass B whatever A left behind.
      await a.unsafe('begin');
      const claimedA = await a<{ id: string }[]>`
        select id from poster.claim_due_targets('tiktok', 'worker-a', 1000)`;
      expect(claimedA.length).toBeGreaterThanOrEqual(TARGET_COUNT);

      await b.unsafe('begin');
      const claimedB = await b<{ id: string }[]>`
        select id from poster.claim_due_targets('tiktok', 'worker-b', 1000)`;

      // Not "it waits": skip locked means it returns nothing and moves on, so one
      // platform's backlog cannot block another loop (CLAUDE.md rule 10).
      expect(claimedB).toEqual([]);

      await a.unsafe('rollback');
      await b.unsafe('rollback');
    } finally {
      await a.release();
      await b.release();
    }
  });

  it('restores every target to scheduled once both transactions roll back', async () => {
    const rows = await admin<{ state: string; count: bigint }[]>`
      select t.state::text as state, count(*) as count
        from poster.post_targets t
       where t.connection_id = ${ids.connection}
       group by t.state`;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('scheduled');
    expect(Number(rows[0]?.count)).toBe(TARGET_COUNT);
  });
});
