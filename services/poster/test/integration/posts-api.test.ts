/**
 * Post submission, idempotency, cancel and edit against a real database.
 *
 * These are the S05 acceptance criteria, and they belong here rather than in a
 * unit suite because every one of them is a property of Postgres: idempotency is
 * a blocking primary-key insert, "exactly one post" only means something under
 * real concurrency, and `due_at` defaulting is a column default.
 *
 * Requires a running local stack (`pnpm exec supabase start`).
 */
import {
  encodeId,
  type CancelPostResponse,
  type ErrorEnvelope,
  type Post,
  type PostDetail,
} from '@suite/poster-contract';
import {
  InMemoryRateLimiter,
  createAppTokenSigner,
  createUserTokenVerifier,
} from '@suite/server-core';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { loadConfig } from '../../src/config.js';
import { createClientAppStore } from '../../src/db/client-apps.js';
import { createGrantStore } from '../../src/db/grants.js';
import { createMediaStore } from '../../src/db/media.js';
import { createPlatformConstraintStore } from '../../src/db/platform-constraints.js';
import { createPostStore } from '../../src/db/posts.js';
import { createValidationContextStore } from '../../src/db/validation-context.js';
import { loadConstraints, readSpecs, specDirectory } from '../../src/seed-constraints.js';
import { seedGrants } from '../../src/seed-grants.js';
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, seed } from '../../src/seed.js';
import { createStubProber, createStubStorage } from '../helpers/build-test-server.js';

const DATABASE_URL =
  process.env['POSTER_TEST_DATABASE_URL'] ??
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const SUPABASE_URL = process.env['POSTER_TEST_SUPABASE_URL'] ?? 'http://127.0.0.1:54321';
const APP_TOKEN_SECRET = 'posts-integration-signing-secret32!!';
const repoRoot = process.cwd().replace(/\/services\/poster$/, '');

const ids = {
  user: crypto.randomUUID(),
  credential: crypto.randomUUID(),
  tiktok: crypto.randomUUID(),
  youtube: crypto.randomUUID(),
  media: crypto.randomUUID(),
  /** A second user's connection, for the ungranted case. */
  otherUser: crypto.randomUUID(),
};

const sql = postgres(DATABASE_URL, { max: 6, onnotice: () => {} });
let app: FastifyInstance | undefined;
let baseUrl = '';
let token = '';
let reachable = false;

const tiktokId = () => encodeId('connection', ids.tiktok);
const youtubeId = () => encodeId('connection', ids.youtube);
const mediaId = () => encodeId('media', ids.media);

async function cleanup(): Promise<void> {
  for (const user of [ids.user, ids.otherUser]) {
    await sql`delete from poster.posts where user_id = ${user}`;
    await sql`delete from poster.media where user_id = ${user}`;
    await sql`delete from poster.grants where user_id = ${user}`;
    await sql`delete from poster.connections where user_id = ${user}`;
    await sql`delete from poster.credentials where user_id = ${user}`;
    await sql`delete from auth.users where id = ${user}`;
  }
  await sql`delete from poster.idempotency_keys where key like 'itest-%'`;
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

  for (const [id, email] of [
    [ids.user, `posts-${ids.user}@example.test`],
    [ids.otherUser, `other-${ids.otherUser}@example.test`],
  ] as const) {
    await sql`
      insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${email}, 'x', now(), now())`;
  }

  await sql`
    insert into poster.credentials (id, user_id, kind, provider, ciphertext, wrapped_dek, kms_key_id, nonce)
    values (${ids.credential}, ${ids.user}, 'aggregator_profile', 'ayrshare', '\\x01', '\\x02', 'kms', '\\x03')`;
  await sql`
    insert into poster.connections (id, user_id, platform_id, credential_id, external_account_id) values
      (${ids.tiktok},  ${ids.user}, 'tiktok',  ${ids.credential}, ${`tt-${ids.tiktok}`}),
      (${ids.youtube}, ${ids.user}, 'youtube', ${ids.credential}, ${`yt-${ids.youtube}`})`;

  const apps = await sql<{ id: string }[]>`
    select id from poster.client_apps where client_id = ${TEST_CLIENT_ID}`;
  await sql`
    insert into poster.media (id, user_id, app_id, kind, status, storage_path, mime_type,
                              duration_ms, width, height)
    values (${ids.media}, ${ids.user}, ${apps[0]?.id ?? null}, 'video', 'ready',
            ${`itest/${ids.media}.mp4`}, 'video/mp4', 30000, 1080, 1920)`;

  // Development stand-in for M2's consent flow (D-067).
  await seedGrants(DATABASE_URL, { userId: ids.user, clientId: TEST_CLIENT_ID });

  app = buildServer(
    { ...loadConfig(), logLevel: 'fatal' },
    {
      apps: createClientAppStore(sql),
      constraints: createPlatformConstraintStore(sql),
      validationContext: createValidationContextStore(sql),
      grants: createGrantStore(sql),
      mediaStore: createMediaStore(sql),
      postStore: createPostStore(sql),
      // Posts never touch storage or ffprobe; media has its own suite.
      storage: createStubStorage(),
      prober: createStubProber(),
      maxDirectUploadBytes: 8 * 1024 * 1024,
      signedUrlTtlS: 3600,
      appTokens: createAppTokenSigner({
        secret: APP_TOKEN_SECRET,
        keyId: 'k1',
        issuer: 'poster-api',
        audience: 'poster-api',
      }),
      userTokens: createUserTokenVerifier({
        jwksUrl: `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
        issuer: `${SUPABASE_URL}/auth/v1`,
      }),
      rateLimiter: new InMemoryRateLimiter(),
      appTokenIssuer: 'poster-api',
      firstPartyClientId: 'poster-web',
      tokenEndpointLimitPerMin: 1000,
      corsOrigins: [],
    },
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  baseUrl =
    typeof address === 'object' && address !== null
      ? `http://127.0.0.1:${String(address.port)}`
      : '';

  const response = await fetch(`${baseUrl}/v1/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: TEST_CLIENT_ID,
      client_secret: TEST_CLIENT_SECRET,
    }),
  });
  token = ((await response.json()) as { access_token: string }).access_token;
});

afterEach(async () => {
  if (reachable) {
    await sql`delete from poster.posts where user_id = ${ids.user}`;
    await sql`delete from poster.idempotency_keys where key like 'itest-%'`;
  }
});

afterAll(async () => {
  await app?.close();
  if (reachable) await cleanup();
  await sql.end({ timeout: 5 });
});

function submission(over: Record<string, unknown> = {}) {
  return {
    user_id: ids.user,
    content: { text: 'A caption', title: 'A title', media: [mediaId()] },
    targets: [{ connection_id: tiktokId() }, { connection_id: youtubeId() }],
    ...over,
  };
}

function submit(body: unknown, key?: string): Promise<Response> {
  return fetch(`${baseUrl}/v1/posts`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    body: JSON.stringify(body),
  });
}

async function countPosts(): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    select count(*) as n from poster.posts where user_id = ${ids.user}`;
  return Number(rows[0]?.n ?? 0);
}

describe('environment', () => {
  it('has a reachable database', () => {
    expect(reachable, `need a local stack for ${DATABASE_URL}`).toBe(true);
  });
});

describe('POST /v1/posts', () => {
  it('accepts a two-target submission and creates both targets', async () => {
    const response = await submit(submission());
    expect(response.status).toBe(202);

    const body = (await response.json()) as Post;
    expect(body.post_id).toMatch(/^po_/);
    expect(body.targets).toHaveLength(2);
    expect(body.targets.map((target) => target.platform_id)).toEqual(['tiktok', 'youtube']);
    expect(body.targets.map((target) => target.position)).toEqual([0, 1]);
    for (const target of body.targets) expect(target.target_id).toMatch(/^tg_/);
  });

  it('creates nothing at all when one target fails validation', async () => {
    // "Nothing is partially accepted" (§5).
    const response = await submit(
      submission({ content: { text: 'a'.repeat(3000), media: [mediaId()] } }),
    );
    expect(response.status).toBe(422);
    expect(await countPosts()).toBe(0);
  });

  it('refuses a connection the app holds no grant for (403 grant_missing)', async () => {
    await sql`update poster.grants set revoked_at = now()
               where user_id = ${ids.user} and revoked_at is null`;
    try {
      const response = await submit(submission());
      expect(response.status).toBe(403);
      expect(((await response.json()) as ErrorEnvelope).error.code).toBe('grant_missing');
      expect(await countPosts()).toBe(0);
    } finally {
      await sql`delete from poster.grants where user_id = ${ids.user}`;
      await seedGrants(DATABASE_URL, { userId: ids.user, clientId: TEST_CLIENT_ID });
    }
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 1: idempotency
// ---------------------------------------------------------------------------
describe('idempotency (FR-14)', () => {
  it('returns the identical response for the same key and body', async () => {
    const key = `itest-${crypto.randomUUID()}`;
    const first = await submit(submission(), key);
    const second = await submit(submission(), key);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);

    const a = (await first.json()) as Post;
    const b = (await second.json()) as Post;
    expect(b).toEqual(a);
    expect(await countPosts()).toBe(1);
  });

  it('returns 409 idempotency_conflict for the same key with a different body', async () => {
    const key = `itest-${crypto.randomUUID()}`;
    await submit(submission(), key);

    const conflicting = await submit(submission({ external_ref: 'changed' }), key);
    expect(conflicting.status).toBe(409);
    expect(((await conflicting.json()) as ErrorEnvelope).error.code).toBe('idempotency_conflict');
    expect(await countPosts()).toBe(1);
  });

  it('is insensitive to key order in the body, since the hash is canonical', async () => {
    const key = `itest-${crypto.randomUUID()}`;
    const first = await submit(
      {
        user_id: ids.user,
        content: { text: 'x', media: [mediaId()] },
        targets: [{ connection_id: tiktokId() }],
      },
      key,
    );
    const reordered = await submit(
      {
        targets: [{ connection_id: tiktokId() }],
        content: { media: [mediaId()], text: 'x' },
        user_id: ids.user,
      },
      key,
    );

    expect(first.status).toBe(202);
    expect(reordered.status).toBe(202);
    expect(await countPosts()).toBe(1);
  });

  it('creates exactly one post from six parallel identical requests', async () => {
    const key = `itest-${crypto.randomUUID()}`;
    const responses = await Promise.all(Array.from({ length: 6 }, () => submit(submission(), key)));

    // Every caller gets the same answer; only one post exists.
    expect(responses.map((response) => response.status)).toEqual(Array(6).fill(202));
    const bodies = (await Promise.all(responses.map((response) => response.json()))) as Post[];
    const postIds = new Set(bodies.map((body) => body.post_id));
    expect(postIds.size, `saw post ids ${[...postIds].join(', ')}`).toBe(1);

    expect(await countPosts()).toBe(1);
    const targets = await sql<{ n: string }[]>`
      select count(*) as n from poster.post_targets where user_id = ${ids.user}`;
    expect(Number(targets[0]?.n)).toBe(2);
  });

  it('creates a separate post per request when no key is sent', async () => {
    // The contract's warning made concrete: without a key, a retry duplicates.
    await submit(submission());
    await submit(submission());
    expect(await countPosts()).toBe(2);
  });

  it('lets a client fix a rejected body and reuse the same key', async () => {
    const key = `itest-${crypto.randomUUID()}`;
    const rejected = await submit(
      submission({ content: { text: 'a'.repeat(3000), media: [mediaId()] } }),
      key,
    );
    expect(rejected.status).toBe(422);

    // A validation failure claims no key, so the corrected request is not a conflict.
    const fixed = await submit(submission(), key);
    expect(fixed.status).toBe(202);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 3: schedule_at defaulting
// ---------------------------------------------------------------------------
describe('scheduling (§5)', () => {
  it('sets due_at to now when schedule_at is omitted', async () => {
    const before = new Date();
    const response = await submit(submission());
    expect(response.status).toBe(202);
    const after = new Date();

    const rows = await sql<{ due_at: Date; schedule_at: Date | null }[]>`
      select t.due_at, p.schedule_at
        from poster.post_targets t join poster.posts p on p.id = t.post_id
       where t.user_id = ${ids.user}`;

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.schedule_at).toBeNull();
      expect(row.due_at.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
      expect(row.due_at.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
    }
  });

  it('uses schedule_at as due_at when given', async () => {
    const when = new Date(Date.now() + 3_600_000);
    const response = await submit(submission({ schedule_at: when.toISOString() }));
    expect(response.status).toBe(202);

    const rows = await sql<{ due_at: Date }[]>`
      select due_at from poster.post_targets where user_id = ${ids.user}`;
    for (const row of rows) expect(row.due_at.toISOString()).toBe(when.toISOString());
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 2: cancel
// ---------------------------------------------------------------------------
describe('POST /v1/posts/{id}/cancel (§6)', () => {
  async function createPost(): Promise<Post> {
    const response = await submit(submission());
    return (await response.json()) as Post;
  }

  function cancel(postId: string): Promise<Response> {
    return fetch(`${baseUrl}/v1/posts/${postId}/cancel?user_id=${ids.user}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it('cancels a scheduled post', async () => {
    const post = await createPost();
    const response = await cancel(post.post_id);

    expect(response.status).toBe(200);
    const body = (await response.json()) as CancelPostResponse;
    expect(body.canceled_target_ids).toHaveLength(2);
    expect(body.state).toBe('canceled');
  });

  it('cancels a paused post', async () => {
    const post = await createPost();
    await sql`update poster.post_targets set state = 'paused' where user_id = ${ids.user}`;

    const response = await cancel(post.post_id);
    expect(response.status).toBe(200);
    expect(((await response.json()) as CancelPostResponse).canceled_target_ids).toHaveLength(2);
  });

  it('returns 409 too_late once every target is dispatching', async () => {
    const post = await createPost();
    await sql`
      update poster.post_targets
         set state = 'dispatching', claimed_by = 'w1', claim_expires_at = now() + interval '5 min'
       where user_id = ${ids.user}`;

    const response = await cancel(post.post_id);
    expect(response.status).toBe(409);
    expect(((await response.json()) as ErrorEnvelope).error.code).toBe('too_late');
  });

  it('cancels what it can when one target is already dispatching', async () => {
    const post = await createPost();
    await sql`
      update poster.post_targets
         set state = 'dispatching', claimed_by = 'w1', claim_expires_at = now() + interval '5 min'
       where user_id = ${ids.user} and position = 0`;

    // A dispatching target genuinely cannot be recalled; the other one can, and
    // refusing the whole call would leave it queued for no reason (D-068).
    const response = await cancel(post.post_id);
    expect(response.status).toBe(200);
    expect(((await response.json()) as CancelPostResponse).canceled_target_ids).toHaveLength(1);
  });

  it('is safe to retry: a second cancel returns 200 with nothing canceled', async () => {
    const post = await createPost();
    await cancel(post.post_id);

    const again = await cancel(post.post_id);
    expect(again.status).toBe(200);
    expect(((await again.json()) as CancelPostResponse).canceled_target_ids).toEqual([]);
  });

  it('404s an unknown post', async () => {
    const response = await cancel(encodeId('post', crypto.randomUUID()));
    expect(response.status).toBe(404);
  });
});

describe('GET and PATCH /v1/posts/{id} (FR-13)', () => {
  async function createPost(): Promise<Post> {
    return (await (await submit(submission())).json()) as Post;
  }

  function patch(postId: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/v1/posts/${postId}?user_id=${ids.user}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('reads back the post with per-target detail', async () => {
    const post = await createPost();
    const response = await fetch(`${baseUrl}/v1/posts/${post.post_id}?user_id=${ids.user}`, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    const detail = (await response.json()) as PostDetail;
    expect(detail.post_id).toBe(post.post_id);
    expect(detail.targets).toHaveLength(2);
    expect(detail.targets[0]?.attempt_count).toBe(0);
    expect(detail.targets[0]?.permalink).toBeNull();
  });

  it('re-validates an edit and rejects one that breaks a platform rule', async () => {
    const post = await createPost();
    const response = await patch(post.post_id, {
      content: { text: 'a'.repeat(3000), media: [mediaId()] },
    });

    expect(response.status).toBe(422);
    const envelope = (await response.json()) as ErrorEnvelope;
    expect(envelope.error.code).toBe('constraint_violation');
    expect(envelope.error.details?.[0]?.target_index).toBe(0);
  });

  it('applies a valid edit and reschedules', async () => {
    const post = await createPost();
    const when = new Date(Date.now() + 7_200_000);
    const response = await patch(post.post_id, {
      content: { text: 'An edited caption', title: 'Edited', media: [mediaId()] },
      schedule_at: when.toISOString(),
    });

    expect(response.status).toBe(200);
    const detail = (await response.json()) as PostDetail;
    expect(detail.content.text).toBe('An edited caption');
    expect(detail.targets).toHaveLength(2);
    for (const target of detail.targets) expect(target.due_at).toBe(when.toISOString());
  });

  it('refuses an edit once a target is dispatching', async () => {
    const post = await createPost();
    await sql`
      update poster.post_targets
         set state = 'dispatching', claimed_by = 'w1', claim_expires_at = now() + interval '5 min'
       where user_id = ${ids.user} and position = 0`;

    const response = await patch(post.post_id, {
      content: { text: 'too late', media: [mediaId()] },
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as ErrorEnvelope).error.code).toBe('too_late');
  });
});
