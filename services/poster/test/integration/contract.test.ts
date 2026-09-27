/**
 * The contract test D-026 asks for: **the running service's responses must
 * validate against the generated spec.**
 *
 * The point is not that our zod schemas are self-consistent — they are, by
 * construction. It is that `packages/poster-contract/openapi.json`, the artifact
 * every client is generated from, describes what the service actually does. Those
 * come apart in two directions and this catches both:
 *
 *   - a response the spec does not describe (a field added in code, or a status
 *     the spec never mentions);
 *   - an operation the spec under-declares, so a generated client cannot express a
 *     legal request. That is how `user_id` went missing from the three
 *     post-scoped routes until the M1 demo tried to call them (D-096), which is
 *     why this suite also asserts the *request* side: every parameter a route
 *     genuinely needs has to be declared.
 *
 * Validation is by ajv against the spec's own schemas, with `components` supplied
 * as the `$ref` namespace, so nothing here restates a shape.
 *
 * Requires a running local stack (`pnpm exec supabase start`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { encodeId } from '@suite/poster-contract';
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
import { loadConstraints, readSpecs, specDirectory } from '../../src/seed-constraints.js';
import { seedGrants } from '../../src/seed-grants.js';
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, seed } from '../../src/seed.js';
import { createStubProber, createStubStorage } from '../helpers/build-test-server.js';

const DATABASE_URL =
  process.env['POSTER_TEST_DATABASE_URL'] ??
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const SUPABASE_URL = process.env['POSTER_TEST_SUPABASE_URL'] ?? 'http://127.0.0.1:54321';
const APP_TOKEN_SECRET = 'contract-integration-signing-secret!!';
const repoRoot = process.cwd().replace(/\/services\/poster$/, '');

interface OpenApiSpec {
  openapi: string;
  info: { version: string };
  paths: Record<
    string,
    Record<
      string,
      {
        parameters?: { name: string; in: string; required?: boolean }[];
        responses: Record<string, { content?: Record<string, { schema: unknown }> }>;
      }
    >
  >;
  components: { schemas: Record<string, unknown> };
}

const spec = JSON.parse(
  readFileSync(join(repoRoot, 'packages', 'poster-contract', 'openapi.json'), 'utf8'),
) as OpenApiSpec;

/**
 * Translates the spec's OpenAPI 3.0 dialect into the JSON Schema ajv speaks.
 *
 * The spec is generated with `target: 'openapi-3.0'` (D-026), which differs from
 * JSON Schema in two ways that matter here:
 *
 *   - **`nullable: true`** as a sibling keyword, rather than `type: [..., 'null']`.
 *     ajv does not know the keyword, so it would ignore it and reject every
 *     `null` — a scheduled target's `reason_class` among them.
 *   - **`exclusiveMinimum: true` beside `minimum: 0`**, rather than
 *     `exclusiveMinimum: 0`. ajv rejects the boolean form outright.
 *
 * Translating here is the bridge. Without it this suite reports the *validator's*
 * dialect gap as a service defect, which is worse than having no test: it would
 * train us to ignore it.
 */
function toJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toJsonSchema);
  if (node === null || typeof node !== 'object') return node;

  const source = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === 'nullable') continue;
    out[key] = toJsonSchema(value);
  }

  // `minimum: 0, exclusiveMinimum: true` → `exclusiveMinimum: 0`.
  for (const [bound, exclusive] of [
    ['minimum', 'exclusiveMinimum'],
    ['maximum', 'exclusiveMaximum'],
  ] as const) {
    if (out[exclusive] === true) {
      if (typeof out[bound] === 'number') {
        out[exclusive] = out[bound];
        delete out[bound];
      } else {
        delete out[exclusive];
      }
    } else if (out[exclusive] === false) {
      delete out[exclusive];
    }
  }

  if (source['nullable'] === true) {
    const { type, enum: enumValues, ...rest } = out;
    // A nullable enum needs `null` in the enum too: the enum is checked
    // independently of `type`, so widening the type alone is not enough.
    return {
      ...rest,
      ...(type === undefined ? {} : { type: [type, 'null'] }),
      ...(Array.isArray(enumValues) ? { enum: [...enumValues, null] } : {}),
    };
  }

  return out;
}

const jsonSchemaSpec = toJsonSchema(spec) as OpenApiSpec;

/**
 * One ajv instance holding the whole spec, so `$ref: '#/components/schemas/X'`
 * resolves exactly as it does for a code generator.
 */
/**
 * `ajv-formats` is a CommonJS package whose types use an ESM-style
 * `export default`, which NodeNext resolves to the module namespace rather than
 * to the function. The runtime value is already the function; only the type needs
 * correcting, so this is a cast and not an interop shim.
 */
const addFormats = addFormatsModule as unknown as (typeof addFormatsModule)['default'];

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(jsonSchemaSpec, 'openapi.json');

const validators = new Map<string, ValidateFunction>();

function validatorFor(path: string, method: string, status: number): ValidateFunction {
  const key = `${method} ${path} ${String(status)}`;
  const cached = validators.get(key);
  if (cached !== undefined) return cached;

  const operation = jsonSchemaSpec.paths[path]?.[method];
  expect(operation, `${method.toUpperCase()} ${path} is not in the spec`).toBeDefined();

  const response = operation?.responses[String(status)];
  expect(
    response,
    `${method.toUpperCase()} ${path} does not declare a ${String(status)} response`,
  ).toBeDefined();

  const schema = response?.content?.['application/json']?.schema;
  expect(schema, `${key} declares no application/json schema`).toBeDefined();

  const compiled = ajv.compile({ ...(schema as object), components: jsonSchemaSpec.components });
  validators.set(key, compiled);
  return compiled;
}

interface Checked {
  readonly status: number;
  readonly body: unknown;
}

/** Calls the service and validates the response against the spec for its status. */
async function check(
  method: 'GET' | 'POST' | 'PATCH',
  specPath: string,
  requestPath: string,
  init: RequestInit = {},
): Promise<Checked> {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init.headers },
  });
  const body: unknown = await response.json();

  const validate = validatorFor(specPath, method.toLowerCase(), response.status);
  const valid = validate(body);
  expect(
    valid,
    `${method} ${requestPath} → ${String(response.status)} does not match the spec: ` +
      ajv.errorsText(validate.errors, { separator: '; ' }) +
      `\nbody: ${JSON.stringify(body)}`,
  ).toBe(true);

  return { status: response.status, body };
}

const ids = {
  user: crypto.randomUUID(),
  credential: crypto.randomUUID(),
  tiktok: crypto.randomUUID(),
  youtube: crypto.randomUUID(),
  media: crypto.randomUUID(),
};

const sql = postgres(DATABASE_URL, { max: 6, onnotice: () => {} });
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
  await sql`delete from poster.idempotency_keys where key like 'contract-%'`;
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

  await sql`
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
    values (${ids.user}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`contract-${ids.user}@example.test`}, 'x', now(), now())`;
  await sql`
    insert into poster.credentials (id, user_id, kind, provider, ciphertext, wrapped_dek, kms_key_id, nonce)
    values (${ids.credential}, ${ids.user}, 'aggregator_profile', 'fake', '\\x01', '\\x02', 'kms', '\\x03')`;
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
            ${`contract/${ids.media}.mp4`}, 'video/mp4', 30000, 1080, 1920)`;

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

afterAll(async () => {
  if (reachable) await cleanup();
  await app?.close();
  await sql.end({ timeout: 5 });
});

describe('environment', () => {
  it('has a reachable database', () => {
    expect(reachable, `need a local stack for ${DATABASE_URL}`).toBe(true);
  });
});

describe('the spec describes the service (D-026)', () => {
  it('ships a spec whose version matches the contract package', async () => {
    const { CONTRACT_VERSION } = await import('@suite/poster-contract');
    expect(spec.info.version).toBe(CONTRACT_VERSION);
  });

  it('validates the token response', async () => {
    const response = await fetch(`${baseUrl}/v1/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: TEST_CLIENT_ID,
        client_secret: TEST_CLIENT_SECRET,
      }),
    });
    const body: unknown = await response.json();
    const validate = validatorFor('/v1/oauth/token', 'post', 200);
    expect(validate(body), ajv.errorsText(validate.errors)).toBe(true);
  });

  it('validates the auth context', async () => {
    await check('GET', '/v1/auth/context', `/v1/auth/context?user_id=${ids.user}`);
  });

  it('validates platform constraints', async () => {
    const { body } = await check('GET', '/v1/platforms/constraints', '/v1/platforms/constraints');
    // Guards against a vacuous pass: an empty platform list would satisfy the
    // schema while proving nothing about the specs themselves.
    expect((body as { platforms: unknown[] }).platforms.length).toBeGreaterThan(0);
  });

  it('validates a successful validate call', async () => {
    await check('POST', '/v1/posts/validate', '/v1/posts/validate', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user_id: ids.user,
        content: { text: 'contract check', media: [encodeId('media', ids.media)] },
        targets: [{ connection_id: encodeId('connection', ids.tiktok) }],
      }),
    });
  });

  it('validates the constraint-violation envelope', async () => {
    // A 422 is as much part of the contract as a 200, and §8's `details` array is
    // the part a client actually switches on.
    const response = await fetch(`${baseUrl}/v1/posts/validate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        user_id: ids.user,
        content: { text: 'no media, which video platforms refuse' },
        targets: [{ connection_id: encodeId('connection', ids.tiktok) }],
      }),
    });
    expect(response.status).toBe(422);

    const body: unknown = await response.json();
    const validate = validatorFor('/v1/posts/validate', 'post', 422);
    expect(validate(body), ajv.errorsText(validate.errors)).toBe(true);
    expect((body as { error: { details?: unknown[] } }).error.details?.length).toBeGreaterThan(0);
  });

  it('validates the error envelope on an unknown post', async () => {
    const response = await fetch(
      `${baseUrl}/v1/posts/${encodeId('post', crypto.randomUUID())}?user_id=${ids.user}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(404);

    const body: unknown = await response.json();
    const validate = validatorFor('/v1/posts/{post_id}', 'get', 404);
    expect(validate(body), ajv.errorsText(validate.errors)).toBe(true);
  });

  it('validates submission, read, patch and cancel', async () => {
    const submit = await fetch(`${baseUrl}/v1/posts`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'Idempotency-Key': `contract-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({
        user_id: ids.user,
        external_ref: 'contract/check',
        content: { text: 'contract check', media: [encodeId('media', ids.media)] },
        targets: [
          { connection_id: encodeId('connection', ids.tiktok) },
          { connection_id: encodeId('connection', ids.youtube) },
        ],
        schedule_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    });
    expect(submit.status).toBe(202);

    const submitted = (await submit.json()) as { post_id: string };
    const submitValidate = validatorFor('/v1/posts', 'post', 202);
    expect(submitValidate(submitted), ajv.errorsText(submitValidate.errors)).toBe(true);

    const postId = submitted.post_id;
    const query = `?user_id=${ids.user}`;

    await check('GET', '/v1/posts/{post_id}', `/v1/posts/${postId}${query}`);

    await check('PATCH', '/v1/posts/{post_id}', `/v1/posts/${postId}${query}`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user_id: ids.user,
        content: { text: 'edited', media: [encodeId('media', ids.media)] },
      }),
    });

    await check('POST', '/v1/posts/{post_id}/cancel', `/v1/posts/${postId}/cancel${query}`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: ids.user }),
    });
  });
});

describe('the spec lets a generated client express every legal request (D-096)', () => {
  /**
   * The gap the M1 demo hit: a route that needs `user_id`, no request body to put
   * it in, and no declared query parameter — so a typed client simply cannot call
   * it. Asserting the declaration exists is what stops that regressing.
   */
  const needsUserId = [
    ['/v1/posts/{post_id}', 'get'],
    ['/v1/posts/{post_id}', 'patch'],
    ['/v1/posts/{post_id}/cancel', 'post'],
    ['/v1/auth/context', 'get'],
  ] as const;

  it.each(needsUserId)('declares user_id for %s %s', (path, method) => {
    const parameters = spec.paths[path]?.[method]?.parameters ?? [];
    const names = parameters.filter((p) => p.in === 'query').map((p) => p.name);
    expect(names).toContain('user_id');
  });

  it('proves the service really needs it, so the declaration is not decorative', async () => {
    const submit = await fetch(`${baseUrl}/v1/posts`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'Idempotency-Key': `contract-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({
        user_id: ids.user,
        content: { text: 'needs user_id', media: [encodeId('media', ids.media)] },
        targets: [{ connection_id: encodeId('connection', ids.tiktok) }],
        schedule_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    });
    const { post_id: postId } = (await submit.json()) as { post_id: string };

    const without = await fetch(`${baseUrl}/v1/posts/${postId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(without.status).toBe(400);

    const withIt = await fetch(`${baseUrl}/v1/posts/${postId}?user_id=${ids.user}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(withIt.status).toBe(200);
  });
});
