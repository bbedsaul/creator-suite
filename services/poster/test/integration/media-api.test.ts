/**
 * Media upload against real Supabase Storage and a real ffprobe (FR-07).
 *
 * The upload paths are only meaningful end to end: a stubbed storage proves
 * nothing about signed URLs, and a stubbed prober proves nothing about reading
 * dimensions out of a file. ffprobe comes from the @ffprobe-installer
 * devDependency, pointed at via FFPROBE_PATH — the same hook production uses to
 * find the binary that `apk add ffmpeg` puts on PATH (D-062).
 *
 * Requires a running local stack with storage (`pnpm exec supabase start`).
 */
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import {
  encodeId,
  type ErrorEnvelope,
  type Media,
  type SignedUploadResponse,
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
import { createGrantStore } from '../../src/db/grants.js';
import { createMediaStore } from '../../src/db/media.js';
import { createPlatformConstraintStore } from '../../src/db/platform-constraints.js';
import { createPostStore } from '../../src/db/posts.js';
import { createValidationContextStore } from '../../src/db/validation-context.js';
import { createFfprobeProber } from '../../src/media/prober.js';
import { createSupabaseStorage, ensureBucket } from '../../src/media/storage.js';
import { loadConstraints, readSpecs, specDirectory } from '../../src/seed-constraints.js';
import { seedGrants } from '../../src/seed-grants.js';
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, seed } from '../../src/seed.js';

const DATABASE_URL =
  process.env['POSTER_TEST_DATABASE_URL'] ??
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const SUPABASE_URL = process.env['POSTER_TEST_SUPABASE_URL'] ?? 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const BUCKET = 'poster-media-itest';
const repoRoot = process.cwd().replace(/\/services\/poster$/, '');

/** A valid 1x1 PNG. Small enough to inline, real enough for ffprobe to read. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
);

const ids = {
  user: crypto.randomUUID(),
  credential: crypto.randomUUID(),
  connection: crypto.randomUUID(),
};

const sql = postgres(DATABASE_URL, { max: 4, onnotice: () => {} });
let app: FastifyInstance | undefined;
let baseUrl = '';
let token = '';
let reachable = false;

async function cleanup(): Promise<void> {
  await sql`delete from poster.posts where user_id = ${ids.user}`;
  await sql`delete from poster.media where user_id = ${ids.user}`;
  await sql`delete from poster.grants where user_id = ${ids.user}`;
  await sql`delete from poster.connections where user_id = ${ids.user}`;
  await sql`delete from poster.credentials where user_id = ${ids.user}`;
  await sql`delete from auth.users where id = ${ids.user}`;
}

beforeAll(async () => {
  // Point the prober at the packaged binary before anything constructs it.
  process.env['FFPROBE_PATH'] = ffprobeInstaller.path;

  const storageOptions = {
    url: SUPABASE_URL,
    serviceRoleKey: SERVICE_ROLE_KEY,
    bucket: BUCKET,
    signedUrlTtlS: 600,
  };

  try {
    await sql`select 1`;
    await ensureBucket(storageOptions);
    reachable = true;
  } catch {
    return;
  }

  await cleanup();
  await seed(DATABASE_URL);
  await loadConstraints(DATABASE_URL, readSpecs(specDirectory(repoRoot)));

  await sql`
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
    values (${ids.user}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`media-${ids.user}@example.test`}, 'x', now(), now())`;
  await sql`
    insert into poster.credentials (id, user_id, kind, provider, ciphertext, wrapped_dek, kms_key_id, nonce)
    values (${ids.credential}, ${ids.user}, 'aggregator_profile', 'ayrshare', '\\x01', '\\x02', 'kms', '\\x03')`;
  await sql`
    insert into poster.connections (id, user_id, platform_id, credential_id, external_account_id)
    values (${ids.connection}, ${ids.user}, 'tiktok', ${ids.credential}, ${`tt-${ids.connection}`})`;
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
      storage: createSupabaseStorage(storageOptions),
      prober: createFfprobeProber(),
      maxDirectUploadBytes: 1024 * 1024,
      signedUrlTtlS: 600,
      appTokens: createAppTokenSigner({
        secret: 'media-integration-signing-secret-32!',
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

afterAll(async () => {
  await app?.close();
  if (reachable) await cleanup();
  await sql.end({ timeout: 5 });
});

function uploadDirect(bytes: Buffer, filename: string, contentType: string): Promise<Response> {
  const form = new FormData();
  form.set('user_id', ids.user);
  form.set('file', new Blob([new Uint8Array(bytes)], { type: contentType }), filename);
  return fetch(`${baseUrl}/v1/media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
}

describe('environment', () => {
  it('has a database, storage, and a usable ffprobe', () => {
    expect(reachable, 'need a local stack with storage').toBe(true);
    expect(ffprobeInstaller.path).toBeTruthy();
  });
});

describe('POST /v1/media — direct upload', () => {
  it('stores the bytes and probes the dimensions', async () => {
    const response = await uploadDirect(ONE_PIXEL_PNG, 'pixel.png', 'image/png');
    expect(response.status).toBe(201);

    const media = (await response.json()) as Media;
    expect(media.media_id).toMatch(/^md_/);
    expect(media.status).toBe('ready');
    expect(media.kind).toBe('image');
    // Read out of the file by ffprobe, not taken from the client.
    expect(media.width).toBe(1);
    expect(media.height).toBe(1);
    expect(media.size_bytes).toBe(ONE_PIXEL_PNG.byteLength);
  });

  it('really put the object in storage', async () => {
    const response = await uploadDirect(ONE_PIXEL_PNG, 'pixel.png', 'image/png');
    const media = (await response.json()) as Media;

    const rows = await sql<{ storage_path: string }[]>`
      select storage_path from poster.media where user_id = ${ids.user} order by created_at desc limit 1`;
    const storage = createSupabaseStorage({
      url: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      bucket: BUCKET,
      signedUrlTtlS: 600,
    });

    const { mkdtemp, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const directory = await mkdtemp(join(tmpdir(), 'media-check-'));
    try {
      const present = await storage.downloadTo(rows[0]?.storage_path ?? '', join(directory, 'f'));
      expect(present).toBe(true);
      expect((await readFile(join(directory, 'f'))).byteLength).toBe(ONE_PIXEL_PNG.byteLength);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    expect(media.status).toBe('ready');
  });

  it('rejects a file ffprobe cannot read', async () => {
    const response = await uploadDirect(Buffer.from('this is not media'), 'junk.png', 'image/png');
    expect(response.status).toBe(400);
    expect(((await response.json()) as ErrorEnvelope).error.code).toBe('invalid_request');
  });

  it('rejects a type that is neither image nor video', async () => {
    const response = await uploadDirect(Buffer.from('%PDF-1.4'), 'doc.pdf', 'application/pdf');
    expect(response.status).toBe(400);
  });
});

describe('POST /v1/media — signed upload', () => {
  async function requestSignedUpload(
    sizeBytes = ONE_PIXEL_PNG.byteLength,
  ): Promise<SignedUploadResponse> {
    const response = await fetch(`${baseUrl}/v1/media`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        user_id: ids.user,
        kind: 'image',
        mime_type: 'image/png',
        size_bytes: sizeBytes,
      }),
    });
    expect(response.status).toBe(202);
    return (await response.json()) as SignedUploadResponse;
  }

  it('issues a pending_upload row and a signed URL', async () => {
    const signed = await requestSignedUpload();
    expect(signed.status).toBe('pending_upload');
    expect(signed.upload_url).toMatch(/^http/);
    expect(new Date(signed.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses to complete before anything has been uploaded', async () => {
    const signed = await requestSignedUpload();
    const response = await fetch(
      `${baseUrl}/v1/media/${signed.media_id}/complete?user_id=${ids.user}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(response.status).toBe(400);
  });

  it('accepts a PUT to the signed URL and probes it on complete', async () => {
    const signed = await requestSignedUpload();

    const put = await fetch(signed.upload_url, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: new Uint8Array(ONE_PIXEL_PNG),
    });
    expect(put.ok, `signed PUT failed: ${put.status} ${await put.text()}`).toBe(true);

    const completed = await fetch(
      `${baseUrl}/v1/media/${signed.media_id}/complete?user_id=${ids.user}`,
      { method: 'POST', headers: { authorization: `Bearer ${token}` } },
    );
    expect(completed.status).toBe(200);

    const media = (await completed.json()) as Media;
    expect(media.status).toBe('ready');
    expect(media.width).toBe(1);
    expect(media.height).toBe(1);
  });

  it('404s completing a media id that is not this user’s', async () => {
    const response = await fetch(
      `${baseUrl}/v1/media/${encodeId('media', crypto.randomUUID())}/complete?user_id=${ids.user}`,
      { method: 'POST', headers: { authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(404);
  });
});

describe('an unfinished upload cannot be posted', () => {
  it('rejects it with media_not_ready rather than posting a missing file', async () => {
    const signed = (await (
      await fetch(`${baseUrl}/v1/media`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          user_id: ids.user,
          kind: 'video',
          mime_type: 'video/mp4',
          size_bytes: 1024,
        }),
      })
    ).json()) as SignedUploadResponse;

    const response = await fetch(`${baseUrl}/v1/posts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        user_id: ids.user,
        content: { text: 'ok', media: [signed.media_id] },
        targets: [{ connection_id: encodeId('connection', ids.connection) }],
      }),
    });

    expect(response.status).toBe(422);
    const envelope = (await response.json()) as ErrorEnvelope;
    expect(envelope.error.details?.[0]?.code).toBe('media_not_ready');
  });
});
