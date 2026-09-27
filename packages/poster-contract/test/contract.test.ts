import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION } from '../src/version.js';
import { ERROR_CODES, ERROR_STATUS, ErrorEnvelope } from '../src/errors.js';
import { AuthContext, TokenRequest, TokenResponse } from '../src/auth.js';
import { buildOpenApiDocument } from '../src/openapi.js';

describe('contract version', () => {
  it('is 1.6, matching the repo doc (D-027, bumped in S10 for the user_id parameter)', () => {
    expect(CONTRACT_VERSION).toBe('1.6');
  });
});

describe('error envelope (contract §8)', () => {
  it('requires a request_id on every error, so any failure is traceable (D-044)', () => {
    const missing = ErrorEnvelope.safeParse({
      error: { code: 'invalid_token', message: 'nope' },
    });
    expect(missing.success).toBe(false);

    const present = ErrorEnvelope.safeParse({
      error: { code: 'invalid_token', message: 'nope', request_id: 'req-1' },
    });
    expect(present.success).toBe(true);
  });

  it('carries per-target details for validation failures (FR-06)', () => {
    const parsed = ErrorEnvelope.safeParse({
      error: {
        code: 'constraint_violation',
        message: '1 of 2 targets failed validation',
        request_id: 'req-2',
        details: [
          {
            target_index: 0,
            connection_id: 'cn_0123456789ABCDEFGHJKMNPQRS',
            code: 'video_too_long',
            constraint: { max_duration_s: 600, actual_s: 745 },
          },
        ],
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('maps every code to the status in the §8 table', () => {
    expect(ERROR_STATUS).toMatchObject({
      invalid_token: 401,
      forbidden_user: 403,
      grant_missing: 403,
      not_found: 404,
      idempotency_conflict: 409,
      too_late: 409,
      constraint_violation: 422,
      rate_limited: 429,
    });
  });

  it('gives every declared code a status, so no handler can pick one at random', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_STATUS[code], `no status for ${code}`).toBeGreaterThanOrEqual(400);
    }
  });
});

describe('auth schemas (contract §2)', () => {
  it('accepts only the client_credentials grant', () => {
    expect(
      TokenRequest.safeParse({
        grant_type: 'password',
        client_id: 'a',
        client_secret: 'b',
      }).success,
    ).toBe(false);
  });

  it('requires a bearer token type and a positive lifetime', () => {
    expect(
      TokenResponse.safeParse({ access_token: 'x', token_type: 'Bearer', expires_in: 900 }).success,
    ).toBe(true);
    expect(
      TokenResponse.safeParse({ access_token: 'x', token_type: 'Bearer', expires_in: 0 }).success,
    ).toBe(false);
  });

  it('allows a null user_id, for app-mode calls that act for nobody', () => {
    const parsed = AuthContext.safeParse({
      mode: 'app',
      app: { client_id: 'trainer-dev', first_party: false },
      user_id: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a non-uuid user_id', () => {
    const parsed = AuthContext.safeParse({
      mode: 'user',
      app: { client_id: 'poster-web', first_party: true },
      user_id: 'not-a-uuid',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('generated OpenAPI document', () => {
  const doc = buildOpenApiDocument() as {
    info: { version: string };
    paths: Record<
      string,
      Record<string, { security?: unknown[]; responses: Record<string, unknown> }>
    >;
    components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
  };

  it('reports the contract version', () => {
    expect(doc.info.version).toBe(CONTRACT_VERSION);
  });

  it('describes the routes that exist and no others', () => {
    expect(Object.keys(doc.paths).sort()).toEqual([
      '/v1/auth/context',
      '/v1/media',
      '/v1/media/{media_id}/complete',
      '/v1/oauth/token',
      '/v1/platforms/constraints',
      '/v1/posts',
      '/v1/posts/validate',
      '/v1/posts/{post_id}',
      '/v1/posts/{post_id}/cancel',
    ]);
  });

  it('leaves the token endpoint unauthenticated and protects the rest', () => {
    expect(doc.paths['/v1/oauth/token']?.['post']?.security).toEqual([]);
    expect(doc.paths['/v1/auth/context']?.['get']?.security).toEqual([{ bearerAuth: [] }]);
  });

  it('documents the error envelope on every failure response', () => {
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const failures = Object.keys(operation.responses).filter((code) => code.startsWith('4'));
        expect(failures.length, `${method} ${path} documents no failures`).toBeGreaterThan(0);
      }
    }
  });

  it('exposes bearer auth as the only security scheme', () => {
    expect(Object.keys(doc.components.securitySchemes)).toEqual(['bearerAuth']);
  });
});
