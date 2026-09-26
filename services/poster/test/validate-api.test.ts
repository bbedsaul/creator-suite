/**
 * GET /v1/platforms/constraints and POST /v1/posts/validate (FR-06, §5.1, §5.2).
 *
 * The headline assertion is the one from the session plan: a two-target request
 * with one bad target produces a 422 carrying exactly one `details` entry, at the
 * right `target_index`. That is what makes a client able to fix the one platform
 * that failed rather than guessing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ErrorEnvelope, PlatformConstraintsResponse } from '@suite/poster-contract';
import {
  FOREIGN_CONNECTION,
  TIKTOK_CONNECTION,
  THIRD_PARTY,
  VIDEO_MEDIA,
  YOUTUBE_CONNECTION,
  buildTestServer,
  createFakeValidationContext,
  type TestServer,
} from './helpers/build-test-server.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let server: TestServer | undefined;

afterEach(async () => {
  await server?.app.close();
  server = undefined;
});

async function authorized(): Promise<{ authorization: string }> {
  const { token } = await (server as TestServer).appTokens.sign({
    sub: THIRD_PARTY.id,
    client_id: THIRD_PARTY.clientId,
    first_party: THIRD_PARTY.firstParty,
  });
  return { authorization: `Bearer ${token}` };
}

function post(body: unknown, headers: Record<string, string>) {
  return (server as TestServer).app.inject({
    method: 'POST',
    url: '/v1/posts/validate',
    headers: { ...headers, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

/** A submission that passes on both platforms. */
function cleanSubmission() {
  return {
    user_id: USER,
    content: { text: 'short', media: [VIDEO_MEDIA] },
    targets: [{ connection_id: TIKTOK_CONNECTION }, { connection_id: YOUTUBE_CONNECTION }],
  };
}

describe('GET /v1/platforms/constraints', () => {
  it('publishes the specs so no client hard-codes a limit (rule 9)', async () => {
    server = await buildTestServer();
    const response = await server.app.inject({
      method: 'GET',
      url: '/v1/platforms/constraints',
      headers: await authorized(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<PlatformConstraintsResponse>();
    expect(body.platforms.map((platform) => platform.platform_id)).toEqual(['tiktok', 'youtube']);
  });

  it('carries the unit with every length limit', async () => {
    server = await buildTestServer();
    const response = await server.app.inject({
      method: 'GET',
      url: '/v1/platforms/constraints',
      headers: await authorized(),
    });

    // A number without its unit is unusable: TikTok counts UTF-16 runes,
    // YouTube counts UTF-8 bytes.
    for (const platform of response.json<PlatformConstraintsResponse>().platforms) {
      expect(platform.spec.text.unit).toBeTruthy();
    }
  });

  it('carries provenance and the provisional flag', async () => {
    server = await buildTestServer();
    const response = await server.app.inject({
      method: 'GET',
      url: '/v1/platforms/constraints',
      headers: await authorized(),
    });

    for (const platform of response.json<PlatformConstraintsResponse>().platforms) {
      expect(platform.spec.sources.length).toBeGreaterThan(0);
      expect(typeof platform.spec.provisional).toBe('boolean');
    }
  });

  it('requires authentication', async () => {
    server = await buildTestServer();
    const response = await server.app.inject({
      method: 'GET',
      url: '/v1/platforms/constraints',
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('POST /v1/posts/validate', () => {
  it('accepts a submission that passes on every target', async () => {
    server = await buildTestServer();
    const response = await post(cleanSubmission(), await authorized());

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      valid: true,
      targets: [
        { target_index: 0, connection_id: TIKTOK_CONNECTION, platform_id: 'tiktok' },
        { target_index: 1, connection_id: YOUTUBE_CONNECTION, platform_id: 'youtube' },
      ],
    });
  });

  // ---- the session plan's criterion -------------------------------------
  it('returns 422 with exactly one details entry when one of two targets fails', async () => {
    server = await buildTestServer();
    const response = await post(
      {
        ...cleanSubmission(),
        // Over TikTok's 10-unit fixture limit, comfortably under YouTube's.
        content: { text: 'this caption is far too long for tiktok', media: [VIDEO_MEDIA] },
      },
      await authorized(),
    );

    expect(response.statusCode).toBe(422);
    const envelope = response.json<ErrorEnvelope>();
    expect(envelope.error.code).toBe('constraint_violation');
    expect(envelope.error.request_id).toBeTruthy();

    expect(envelope.error.details).toHaveLength(1);
    const detail = envelope.error.details?.[0];
    expect(detail?.target_index).toBe(0);
    expect(detail?.connection_id).toBe(TIKTOK_CONNECTION);
    expect(detail?.code).toBe('text_too_long');
    expect(detail?.constraint).toMatchObject({ max_length: 10, unit: 'utf16_code_units' });
  });

  it('says how many targets failed, not just that something did', async () => {
    server = await buildTestServer();
    const response = await post(
      {
        ...cleanSubmission(),
        content: { text: 'this caption is far too long for tiktok', media: [VIDEO_MEDIA] },
      },
      await authorized(),
    );
    expect(response.json<ErrorEnvelope>().error.message).toBe('1 of 2 targets failed validation');
  });

  it('blames the right target when the failure is on the second one', async () => {
    server = await buildTestServer();
    const response = await post(
      {
        user_id: USER,
        // A title only YouTube has, too long for its 100-character fixture limit.
        content: { text: 'ok', title: 'T'.repeat(200), media: [VIDEO_MEDIA] },
        targets: [{ connection_id: TIKTOK_CONNECTION }, { connection_id: YOUTUBE_CONNECTION }],
      },
      await authorized(),
    );

    expect(response.statusCode).toBe(422);
    const details = response.json<ErrorEnvelope>().error.details;
    expect(details).toHaveLength(1);
    expect(details?.[0]?.target_index).toBe(1);
    expect(details?.[0]?.connection_id).toBe(YOUTUBE_CONNECTION);
  });

  it('applies a per-target override instead of the default caption', async () => {
    server = await buildTestServer();
    const response = await post(
      {
        user_id: USER,
        // The default is fine everywhere; the TikTok override is not.
        content: { text: 'ok', media: [VIDEO_MEDIA] },
        targets: [
          { connection_id: TIKTOK_CONNECTION, overrides: { text: 'far too long for tiktok' } },
          { connection_id: YOUTUBE_CONNECTION },
        ],
      },
      await authorized(),
    );

    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorEnvelope>().error.details?.[0]?.target_index).toBe(0);
  });

  it('reports one entry per violation, so two broken rules are two entries', async () => {
    server = await buildTestServer();
    const response = await post(
      {
        user_id: USER,
        content: {
          text: 'far too long for tiktok',
          thread: [{ text: 'a' }, { text: 'b' }],
          media: [VIDEO_MEDIA],
        },
        targets: [{ connection_id: TIKTOK_CONNECTION }],
      },
      await authorized(),
    );

    const details = response.json<ErrorEnvelope>().error.details ?? [];
    expect(details.length).toBeGreaterThan(1);
    expect(new Set(details.map((detail) => detail.target_index))).toEqual(new Set([0]));
    expect(new Set(details.map((detail) => detail.code))).toEqual(
      new Set(['text_too_long', 'thread_not_supported']),
    );
  });

  it('404s an unknown connection rather than calling it a validation failure', async () => {
    server = await buildTestServer();
    const response = await post(
      {
        user_id: USER,
        content: { text: 'ok', media: [VIDEO_MEDIA] },
        targets: [{ connection_id: FOREIGN_CONNECTION }],
      },
      await authorized(),
    );

    // Not this user's connection, so it reads as absent. It is not a content
    // problem, and the API must not confirm other people's ids.
    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorEnvelope>().error.code).toBe('not_found');
  });

  it('404s an unknown media id', async () => {
    server = await buildTestServer();
    const response = await post(
      {
        user_id: USER,
        content: { text: 'ok', media: ['md_ZZZZZZZZZZZZZZZZZZZZZZZZZZ'] },
        targets: [{ connection_id: TIKTOK_CONNECTION }],
      },
      await authorized(),
    );
    expect(response.statusCode).toBe(404);
  });

  it('400s a malformed body instead of a 500', async () => {
    server = await buildTestServer();
    const response = await post({ user_id: 'not-a-uuid', targets: [] }, await authorized());

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorEnvelope>().error.code).toBe('invalid_request');
  });

  it('requires authentication', async () => {
    server = await buildTestServer();
    const response = await post(cleanSubmission(), {});
    expect(response.statusCode).toBe(401);
  });

  it('refuses a user-mode caller validating for a different user', async () => {
    const { createFakeUserTokens } = await import('./helpers/build-test-server.js');
    server = await buildTestServer({
      userTokens: createFakeUserTokens({ 'session-token': USER }),
    });

    const response = await post(
      { ...cleanSubmission(), user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      { authorization: 'Bearer session-token' },
    );
    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorEnvelope>().error.code).toBe('forbidden_user');
  });

  it('fails loudly when a connection’s platform has no published spec', async () => {
    // Accepting it would mean dispatching content that was never checked.
    server = await buildTestServer({
      validationContext: createFakeValidationContext({
        connections: { [TIKTOK_CONNECTION]: 'x' },
      }),
    });

    const response = await post(
      { user_id: USER, content: { text: 'ok' }, targets: [{ connection_id: TIKTOK_CONNECTION }] },
      await authorized(),
    );
    expect(response.statusCode).toBe(500);
    expect(response.json<ErrorEnvelope>().error.code).toBe('internal_error');
  });

  it('rejects a post with no media on a platform that requires it', async () => {
    server = await buildTestServer();
    const response = await post(
      { user_id: USER, content: { text: 'ok' }, targets: [{ connection_id: TIKTOK_CONNECTION }] },
      await authorized(),
    );

    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorEnvelope>().error.details?.[0]?.code).toBe('media_required');
  });
});
