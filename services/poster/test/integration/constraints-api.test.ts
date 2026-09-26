/**
 * The constraint engine against the real seeded specs and a real database.
 *
 * The unit tests use synthetic specs on purpose, so they do not break when a
 * platform changes its rules. This file is the counterpart: it proves the
 * *committed* specs load, serve, and reject as intended, and that the resolver
 * turns public ids into the facts the validator needs.
 *
 * Requires a running local stack (`pnpm exec supabase start`).
 */
import {
  encodeId,
  type ErrorEnvelope,
  type PlatformConstraintsResponse,
} from '@suite/poster-contract';
import {
  InMemoryRateLimiter,
  createAppTokenSigner,
  createUserTokenVerifier,
} from '@suite/server-core';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { loadConfig } from '../../src/config.js';
import { createClientAppStore } from '../../src/db/client-apps.js';
import { createPlatformConstraintStore } from '../../src/db/platform-constraints.js';
import { createValidationContextStore } from '../../src/db/validation-context.js';
import { createGrantStore } from '../../src/db/grants.js';
import { createMediaStore } from '../../src/db/media.js';
import { createPostStore } from '../../src/db/posts.js';
import { createStubProber, createStubStorage } from '../helpers/build-test-server.js';
import { loadConstraints, readSpecs, specDirectory } from '../../src/seed-constraints.js';
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, seed } from '../../src/seed.js';

const DATABASE_URL =
  process.env['POSTER_TEST_DATABASE_URL'] ??
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const SUPABASE_URL = process.env['POSTER_TEST_SUPABASE_URL'] ?? 'http://127.0.0.1:54321';
const APP_TOKEN_SECRET = 'constraint-integration-secret-32ch!!';

const ids = {
  user: crypto.randomUUID(),
  credential: crypto.randomUUID(),
  tiktok: crypto.randomUUID(),
  youtube: crypto.randomUUID(),
  media: crypto.randomUUID(),
};

const sql = postgres(DATABASE_URL, { max: 3, onnotice: () => {} });
let app: FastifyInstance | undefined;
let baseUrl = '';
let token = '';
let reachable = false;

async function cleanup(): Promise<void> {
  await sql`delete from poster.posts where user_id = ${ids.user}`;
  await sql`delete from poster.media where user_id = ${ids.user}`;
  await sql`delete from poster.connections where user_id = ${ids.user}`;
  await sql`delete from poster.credentials where user_id = ${ids.user}`;
  await sql`delete from auth.users where id = ${ids.user}`;
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
  // The specs under test are the committed ones, loaded exactly as ops would.
  await loadConstraints(
    DATABASE_URL,
    readSpecs(specDirectory(process.cwd().replace(/\/services\/poster$/, ''))),
  );

  await sql`
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
    values (${ids.user}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`constraints-${ids.user}@example.test`}, 'x', now(), now())`;
  await sql`
    insert into poster.credentials (id, user_id, kind, provider, ciphertext, wrapped_dek, kms_key_id, nonce)
    values (${ids.credential}, ${ids.user}, 'aggregator_profile', 'ayrshare', '\\x01', '\\x02', 'kms', '\\x03')`;
  await sql`
    insert into poster.connections (id, user_id, platform_id, credential_id, external_account_id) values
      (${ids.tiktok},  ${ids.user}, 'tiktok',  ${ids.credential}, ${`tt-${ids.tiktok}`}),
      (${ids.youtube}, ${ids.user}, 'youtube', ${ids.credential}, ${`yt-${ids.youtube}`})`;

  const app_ = await sql<{ id: string }[]>`
    select id from poster.client_apps where client_id = ${TEST_CLIENT_ID}`;
  await sql`
    insert into poster.media (id, user_id, app_id, kind, status, storage_path, mime_type, duration_ms, width, height)
    values (${ids.media}, ${ids.user}, ${app_[0]?.id ?? null}, 'video', 'ready',
            ${`probe/${ids.media}.mp4`}, 'video/mp4', 30000, 1080, 1920)`;

  app = buildServer(
    { ...loadConfig(), logLevel: 'fatal' },
    {
      apps: createClientAppStore(sql),
      constraints: createPlatformConstraintStore(sql),
      validationContext: createValidationContextStore(sql),
      grants: createGrantStore(sql),
      mediaStore: createMediaStore(sql),
      postStore: createPostStore(sql),
      // These suites cover auth and constraints; posts and media have their own.
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
      tokenEndpointLimitPerMin: 100,
      corsOrigins: [],
    },
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  baseUrl =
    typeof address === 'object' && address !== null
      ? `http://127.0.0.1:${String(address.port)}`
      : '';

  const tokenResponse = await fetch(`${baseUrl}/v1/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: TEST_CLIENT_ID,
      client_secret: TEST_CLIENT_SECRET,
    }),
  });
  token = ((await tokenResponse.json()) as { access_token: string }).access_token;
});

afterAll(async () => {
  await app?.close();
  if (reachable) await cleanup();
  await sql.end({ timeout: 5 });
});

function validate(body: unknown) {
  return fetch(`${baseUrl}/v1/posts/validate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('environment', () => {
  it('has a reachable database', () => {
    expect(reachable, `need a local stack for ${DATABASE_URL}`).toBe(true);
  });
});

describe('GET /v1/platforms/constraints with the committed specs', () => {
  it('serves only the enabled launch platforms', async () => {
    const response = await fetch(`${baseUrl}/v1/platforms/constraints`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as PlatformConstraintsResponse;
    expect(body.platforms.map((platform) => platform.platform_id).sort()).toEqual([
      'tiktok',
      'youtube',
    ]);
  });

  it('serves the real units, which differ between the two platforms', async () => {
    const response = await fetch(`${baseUrl}/v1/platforms/constraints`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await response.json()) as PlatformConstraintsResponse;
    const units = Object.fromEntries(
      body.platforms.map((platform) => [platform.platform_id, platform.spec.text.unit]),
    );

    // The distinction that makes the unit field necessary rather than decorative.
    expect(units['tiktok']).toBe('utf16_code_units');
    expect(units['youtube']).toBe('utf8_bytes');
  });

  it('flags both specs provisional pending the aggregator spike (OQ-1)', async () => {
    const response = await fetch(`${baseUrl}/v1/platforms/constraints`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await response.json()) as PlatformConstraintsResponse;
    for (const platform of body.platforms) {
      expect(platform.spec.provisional).toBe(true);
      expect(platform.spec.sources.length).toBeGreaterThan(0);
    }
  });
});

describe('POST /v1/posts/validate against the committed specs', () => {
  const tiktokId = () => encodeId('connection', ids.tiktok);
  const youtubeId = () => encodeId('connection', ids.youtube);
  const mediaId = () => encodeId('media', ids.media);

  it('accepts a real two-target post', async () => {
    const response = await validate({
      user_id: ids.user,
      content: { text: 'A normal caption', title: 'A normal title', media: [mediaId()] },
      targets: [{ connection_id: tiktokId() }, { connection_id: youtubeId() }],
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { targets: { platform_id: string }[] };
    expect(body.targets.map((target) => target.platform_id)).toEqual(['tiktok', 'youtube']);
  });

  it('rejects a caption over the real TikTok rune limit, on that target only', async () => {
    const constraints = (await (
      await fetch(`${baseUrl}/v1/platforms/constraints`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as PlatformConstraintsResponse;
    const tiktokLimit =
      constraints.platforms.find((platform) => platform.platform_id === 'tiktok')?.spec.text
        .max_length ?? 0;

    const response = await validate({
      user_id: ids.user,
      // One over TikTok's limit, still far under YouTube's byte budget.
      content: { text: 'a'.repeat(tiktokLimit + 1), title: 'ok', media: [mediaId()] },
      targets: [{ connection_id: tiktokId() }, { connection_id: youtubeId() }],
    });

    expect(response.status).toBe(422);
    const envelope = (await response.json()) as ErrorEnvelope;
    expect(envelope.error.details).toHaveLength(1);
    expect(envelope.error.details?.[0]?.target_index).toBe(0);
    expect(envelope.error.details?.[0]?.code).toBe('text_too_long');
  });

  it('rejects the characters YouTube refuses, on that target only', async () => {
    const response = await validate({
      user_id: ids.user,
      content: { text: 'a <b> c', media: [mediaId()] },
      targets: [{ connection_id: tiktokId() }, { connection_id: youtubeId() }],
    });

    expect(response.status).toBe(422);
    const envelope = (await response.json()) as ErrorEnvelope;
    // TikTok's real spec has no forbidden characters, YouTube's does.
    expect(envelope.error.details).toHaveLength(1);
    expect(envelope.error.details?.[0]?.target_index).toBe(1);
    expect(envelope.error.details?.[0]?.code).toBe('text_invalid_characters');
  });

  it('resolves media duration from the database in seconds', async () => {
    // The column is milliseconds; a unit slip here would silently pass a video
    // a thousand times too long.
    const response = await validate({
      user_id: ids.user,
      content: { text: 'ok', media: [mediaId()] },
      targets: [{ connection_id: tiktokId() }],
    });
    expect(response.status).toBe(200);
  });

  it('404s a connection belonging to nobody', async () => {
    const response = await validate({
      user_id: ids.user,
      content: { text: 'ok', media: [mediaId()] },
      targets: [{ connection_id: encodeId('connection', crypto.randomUUID()) }],
    });
    expect(response.status).toBe(404);
  });
});
