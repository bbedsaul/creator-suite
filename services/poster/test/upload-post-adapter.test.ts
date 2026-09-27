/**
 * Upload-Post adapter contract tests.
 *
 * One case per row of the classification table in the `platform-adapter` skill,
 * driven by recorded response shapes (test/fixtures/adapters/PROVENANCE.md).
 *
 * The cases that matter most are the ones that must *not* be `transient`: a 5xx
 * and a mid-flight reset both happen after the video is on the wire, so calling
 * them retryable is how a double post happens.
 */
import { describe, expect, it } from 'vitest';
import { createUploadPostAdapter } from '../src/adapters/upload-post.js';
import {
  ATTEMPT_REF,
  TEST_SECRET,
  failWith,
  loadFixtures,
  lookupRequest,
  neverAnswers,
  publishRequest,
  respondWith,
  target,
  videoRendition,
} from './helpers/adapter-fixtures.js';

const uploads = loadFixtures('upload-post', 'upload');
const histories = loadFixtures('upload-post', 'history');
const users = loadFixtures('upload-post', 'users');

function fixture(store: Record<string, unknown>, name: string): never | ReturnType<typeof Object> {
  const found = store[name];
  if (found === undefined) throw new Error(`no fixture named ${name}`);
  return found;
}

function adapterFor(name: string, store = uploads) {
  const stub = respondWith(fixture(store, name) as never);
  return { adapter: createUploadPostAdapter({ fetch: stub.fetch }), stub };
}

describe('upload-post: publish classification', () => {
  it('reads a sync success as success, with the platform id and permalink', async () => {
    const { adapter } = adapterFor('success_tiktok');
    const outcome = await adapter.publish(publishRequest(TEST_SECRET, 'upload_post'));

    expect(outcome.kind).toBe('success');
    if (outcome.kind !== 'success') return;
    expect(outcome.platformPostId).toBe('v2.7300000000000000000');
    expect(outcome.permalink).toBe('https://www.tiktok.com/@testcreator/video/7300000000000000000');
  });

  it('finds the post id under whichever name the platform used', async () => {
    const { adapter } = adapterFor('success_youtube');
    const outcome = await adapter.publish(
      publishRequest(TEST_SECRET, 'upload_post', {
        target: target({ platformId: 'youtube', title: 'Episode 12' }),
      }),
    );

    expect(outcome.kind).toBe('success');
    if (outcome.kind !== 'success') return;
    expect(outcome.platformPostId).toBe('dQw4w9WgXcQ');
  });

  it('accepts a success that names no identifiers rather than inventing doubt', async () => {
    const { adapter } = adapterFor('success_without_identifiers');
    const outcome = await adapter.publish(publishRequest(TEST_SECRET, 'upload_post'));

    expect(outcome.kind).toBe('success');
    if (outcome.kind !== 'success') return;
    expect(outcome.platformPostId).toBeUndefined();
    expect(outcome.permalink).toBeUndefined();
  });

  it('reads a dead credential as permanent, keeping the provider wording', async () => {
    const { adapter } = adapterFor('expired_token');
    const outcome = await adapter.publish(
      publishRequest(TEST_SECRET, 'upload_post', {
        target: target({ platformId: 'youtube' }),
      }),
    );

    expect(outcome.kind).toBe('permanent');
    if (outcome.kind !== 'permanent') return;
    expect(outcome.message).toBe('Expired access token');
  });

  it('reads an unconfigured platform as permanent with the skip reason', async () => {
    const { adapter } = adapterFor('skipped_not_configured');
    const outcome = await adapter.publish(publishRequest(TEST_SECRET, 'upload_post'));

    expect(outcome.kind).toBe('permanent');
    if (outcome.kind !== 'permanent') return;
    expect(outcome.message).toBe('profile_platform_not_configured');
  });

  it('will not guess when a 200 carries no verdict for the platform we asked for', async () => {
    const { adapter } = adapterFor('missing_platform_result');
    const outcome = await adapter.publish(publishRequest(TEST_SECRET, 'upload_post'));
    expect(outcome.kind).toBe('unknown');
  });

  it('treats an unexpected 202 as unknown, because we never ask it to schedule', async () => {
    const { adapter } = adapterFor('unexpectedly_scheduled');
    const outcome = await adapter.publish(publishRequest(TEST_SECRET, 'upload_post'));
    expect(outcome.kind).toBe('unknown');
  });

  it.each([
    ['bad_request', 400],
    ['unauthorized', 401],
    ['plan_restricted', 403],
  ])('reads %s (%i) as permanent', async (name) => {
    const { adapter } = adapterFor(name);
    const outcome = await adapter.publish(publishRequest(TEST_SECRET, 'upload_post'));
    expect(outcome.kind).toBe('permanent');
  });

  it('reads a 429 as transient and honours Retry-After', async () => {
    const { adapter } = adapterFor('quota_exceeded');
    const before = Date.now();
    const outcome = await adapter.publish(publishRequest(TEST_SECRET, 'upload_post'));

    expect(outcome.kind).toBe('transient');
    if (outcome.kind !== 'transient') return;
    expect(outcome.retryAt).toBeInstanceOf(Date);
    expect(outcome.retryAt?.getTime()).toBeGreaterThanOrEqual(before + 120_000);
  });

  it.each(['server_error', 'platform_unavailable'])(
    'reads %s as unknown, never transient: the video was already sent',
    async (name) => {
      const { adapter } = adapterFor(name);
      const outcome = await adapter.publish(publishRequest(TEST_SECRET, 'upload_post'));
      expect(outcome.kind).toBe('unknown');
    },
  );

  it('refuses a platform it has no provider name for', async () => {
    const { adapter } = adapterFor('success_tiktok');
    const outcome = await adapter.publish(
      publishRequest(TEST_SECRET, 'upload_post', {
        target: target({ platformId: 'mastodon' }),
      }),
    );
    expect(outcome.kind).toBe('permanent');
  });

  it('refuses a target with no video rendition', async () => {
    const { adapter } = adapterFor('success_tiktok');
    const outcome = await adapter.publish(
      publishRequest(TEST_SECRET, 'upload_post', {
        renditions: [videoRendition({ kind: 'image', mimeType: 'image/png' })],
      }),
    );
    expect(outcome.kind).toBe('permanent');
  });
});

describe('upload-post: transport failures', () => {
  it.each(['ECONNREFUSED', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'])(
    'calls %s transient, because the request never left us',
    async (code) => {
      const adapter = createUploadPostAdapter({ fetch: failWith(code) });
      const outcome = await adapter.publish(publishRequest(TEST_SECRET, 'upload_post'));
      expect(outcome.kind).toBe('transient');
    },
  );

  it.each(['ECONNRESET', 'UND_ERR_HEADERS_TIMEOUT', 'SOMETHING_NEW'])(
    'calls %s unknown, because bytes may have gone out',
    async (code) => {
      const adapter = createUploadPostAdapter({ fetch: failWith(code) });
      const outcome = await adapter.publish(publishRequest(TEST_SECRET, 'upload_post'));
      expect(outcome.kind).toBe('unknown');
    },
  );

  it('calls its own timeout unknown', async () => {
    const adapter = createUploadPostAdapter({ fetch: neverAnswers() });
    const outcome = await adapter.publish(
      publishRequest(TEST_SECRET, 'upload_post', { timeoutMs: 20 }),
    );
    expect(outcome.kind).toBe('unknown');
  });
});

describe('upload-post: the request we send', () => {
  it('sends attemptRef as external_id and as the idempotency key', async () => {
    const { adapter, stub } = adapterFor('success_tiktok');
    await adapter.publish(publishRequest(TEST_SECRET, 'upload_post'));

    const call = stub.calls[0];
    expect(call?.url).toBe('https://api.upload-post.com/api/upload');

    const headers = call?.init?.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe(ATTEMPT_REF);
    expect(headers['authorization']).toBe(`Apikey ${TEST_SECRET}`);

    const form = call?.init?.body as FormData;
    expect(form.get('external_id')).toBe(ATTEMPT_REF);
    expect(form.get('user')).toBe('test-creator');
    expect(form.getAll('platform[]')).toEqual(['tiktok']);
    expect(form.get('video')).toBe('https://media.test/signed/clip.mp4');
  });

  it('omits a title it does not have rather than inventing one', async () => {
    const { adapter, stub } = adapterFor('success_youtube');
    await adapter.publish(
      publishRequest(TEST_SECRET, 'upload_post', {
        target: target({ platformId: 'youtube', title: null }),
      }),
    );

    const form = stub.calls[0]?.init?.body as FormData;
    expect(form.get('title')).toBeNull();
  });
});

describe('upload-post: lookup by our own reference', () => {
  it('finds a recorded success', async () => {
    const { adapter } = adapterFor('found_success', histories);
    const outcome = await adapter.lookup(lookupRequest(TEST_SECRET, 'upload_post'));

    expect(outcome.kind).toBe('found');
    if (outcome.kind !== 'found') return;
    expect(outcome.platformPostId).toBe('7300000000000000000');
    expect(outcome.permalink).toContain('tiktok.com');
  });

  it('finds a success the provider did not name', async () => {
    const { adapter } = adapterFor('found_success_without_id', histories);
    const outcome = await adapter.lookup(lookupRequest(TEST_SECRET, 'upload_post'));

    expect(outcome.kind).toBe('found');
    if (outcome.kind !== 'found') return;
    expect(outcome.platformPostId).toBeUndefined();
  });

  it('calls a recorded failure absent: the provider saw it and it did not post', async () => {
    const { adapter } = adapterFor('recorded_failure', histories);
    const outcome = await adapter.lookup(lookupRequest(TEST_SECRET, 'upload_post'));
    expect(outcome.kind).toBe('absent');
  });

  it('calls an empty history absent, which is what makes a retry safe', async () => {
    const { adapter } = adapterFor('empty', histories);
    const outcome = await adapter.lookup(lookupRequest(TEST_SECRET, 'upload_post'));
    expect(outcome.kind).toBe('absent');
  });

  it('will not call it absent while the provider is still working', async () => {
    const { adapter } = adapterFor('empty_but_in_progress', histories);
    const outcome = await adapter.lookup(lookupRequest(TEST_SECRET, 'upload_post'));
    expect(outcome.kind).toBe('unknown');
  });

  it('ignores a record for a different platform', async () => {
    const { adapter } = adapterFor('other_platform_only', histories);
    const outcome = await adapter.lookup(lookupRequest(TEST_SECRET, 'upload_post'));
    expect(outcome.kind).toBe('absent');
  });

  it.each(['unauthorized', 'unreadable'])(
    'answers unknown for %s: being unable to ask is not evidence of absence',
    async (name) => {
      const { adapter } = adapterFor(name, histories);
      const outcome = await adapter.lookup(lookupRequest(TEST_SECRET, 'upload_post'));
      expect(outcome.kind).toBe('unknown');
    },
  );

  it('answers unknown when the lookup itself fails', async () => {
    const adapter = createUploadPostAdapter({ fetch: failWith('ECONNREFUSED') });
    const outcome = await adapter.lookup(lookupRequest(TEST_SECRET, 'upload_post'));
    expect(outcome.kind).toBe('unknown');
  });

  it('sends external_id as an exact filter', async () => {
    const { adapter, stub } = adapterFor('found_success', histories);
    await adapter.lookup(lookupRequest(TEST_SECRET, 'upload_post'));

    const url = new URL(stub.calls[0]?.url ?? '');
    expect(url.pathname).toBe('/api/uploadposts/history');
    expect(url.searchParams.get('external_id')).toBe(ATTEMPT_REF);
  });
});

describe('upload-post: connection health', () => {
  const check = {
    credential: {
      kind: 'aggregator_profile' as const,
      provider: 'upload_post',
      secret: TEST_SECRET,
    },
    platformId: 'tiktok',
    externalAccountId: 'test-creator',
    timeoutMs: 5_000,
  };

  it('reports a linked account active', async () => {
    const { adapter } = adapterFor('active', users);
    expect((await adapter.checkConnection(check)).kind).toBe('active');
  });

  it('reports reauth_required as revoked, not expiring', async () => {
    const { adapter } = adapterFor('reauth_required', users);
    const health = await adapter.checkConnection(check);
    expect(health.kind).toBe('revoked');
  });

  it('reads an empty-string platform entry as unlinked', async () => {
    const { adapter } = adapterFor('platform_unlinked', users);
    expect((await adapter.checkConnection(check)).kind).toBe('revoked');
  });

  it('reports a missing profile as revoked', async () => {
    const { adapter } = adapterFor('no_such_profile', users);
    expect((await adapter.checkConnection(check)).kind).toBe('revoked');
  });

  it.each(['unauthorized', 'unreadable'])('answers unknown for %s', async (name) => {
    const { adapter } = adapterFor(name, users);
    expect((await adapter.checkConnection(check)).kind).toBe('unknown');
  });
});

describe('upload-post: declared capabilities', () => {
  it('serves no platform until one has been verified live (D-083)', () => {
    expect(createUploadPostAdapter().platforms).toEqual([]);
  });

  it('declares both idempotency and reference lookup', () => {
    const adapter = createUploadPostAdapter();
    expect(adapter.supportsIdempotencyKey).toBe(true);
    expect(adapter.supportsReferenceLookup).toBe(true);
  });
});

describe('upload-post: credentials never reach raw (rule 5)', () => {
  it('redacts a credential the provider echoed back', async () => {
    const { adapter } = adapterFor('echoes_credential');
    const outcome = await adapter.publish(publishRequest(TEST_SECRET, 'upload_post'));

    const serialised = JSON.stringify(outcome.raw);
    expect(serialised).not.toContain(TEST_SECRET);
    expect(serialised).toContain('[redacted]');
  });

  it('keeps the credential out of every message', async () => {
    for (const name of Object.keys(uploads)) {
      const { adapter } = adapterFor(name);
      const outcome = await adapter.publish(publishRequest(TEST_SECRET, 'upload_post'));
      expect(JSON.stringify(outcome)).not.toContain(TEST_SECRET);
    }
  });
});
