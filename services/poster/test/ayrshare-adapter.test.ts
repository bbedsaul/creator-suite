/**
 * Ayrshare adapter contract tests.
 *
 * Same classification table as the Upload-Post suite, plus the one thing that
 * separates the two providers: this adapter can never answer `absent`. There is
 * a test for that directly, over every recorded history shape, because it is the
 * property the S09 choice turns on (D-084) and a future "improvement" that made
 * lookup cleverer would silently reintroduce double-post risk.
 */
import { describe, expect, it } from 'vitest';
import { createAyrshareAdapter } from '../src/adapters/ayrshare.js';
import {
  AYRSHARE_TEST_SECRET,
  failWith,
  loadFixtures,
  lookupRequest,
  neverAnswers,
  publishRequest,
  respondWith,
  target,
  type RecordedResponse,
} from './helpers/adapter-fixtures.js';

const posts = loadFixtures('ayrshare', 'post');
const histories = loadFixtures('ayrshare', 'history');
const usersFixtures = loadFixtures('ayrshare', 'user');

function fixture(store: Record<string, RecordedResponse>, name: string): RecordedResponse {
  const found = store[name];
  if (found === undefined) throw new Error(`no fixture named ${name}`);
  return found;
}

function adapterFor(name: string, store = posts) {
  const stub = respondWith(fixture(store, name));
  return { adapter: createAyrshareAdapter({ fetch: stub.fetch }), stub };
}

const SECRET = AYRSHARE_TEST_SECRET;

describe('ayrshare: publish classification', () => {
  it('reads a success as success with the platform id and permalink', async () => {
    const { adapter } = adapterFor('success_youtube');
    const outcome = await adapter.publish(
      publishRequest(SECRET, 'ayrshare', {
        target: target({ platformId: 'youtube', title: 'Episode 12' }),
      }),
    );

    expect(outcome.kind).toBe('success');
    if (outcome.kind !== 'success') return;
    expect(outcome.platformPostId).toBe('dQw4w9WgXcQ');
    expect(outcome.permalink).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('accepts a success that names no id', async () => {
    const { adapter } = adapterFor('success_without_id');
    const outcome = await adapter.publish(publishRequest(SECRET, 'ayrshare'));

    expect(outcome.kind).toBe('success');
    if (outcome.kind !== 'success') return;
    expect(outcome.platformPostId).toBeUndefined();
    expect(outcome.permalink).toBe('https://tiktok.com/x');
  });

  it('reads a pending TikTok post as unknown: there is no post id to trust', async () => {
    const { adapter } = adapterFor('pending_tiktok');
    const outcome = await adapter.publish(publishRequest(SECRET, 'ayrshare'));
    expect(outcome.kind).toBe('unknown');
  });

  it('reads the duplicate-content rejection (137) as permanent, not success', async () => {
    // The body names an earlier post, but that post may be the user's own. Calling
    // this success would attribute someone else's post to this target.
    const { adapter } = adapterFor('duplicate_content');
    const outcome = await adapter.publish(publishRequest(SECRET, 'ayrshare'));

    expect(outcome.kind).toBe('permanent');
    if (outcome.kind !== 'permanent') return;
    expect(outcome.message).toContain('Duplicate or similar content');
  });

  it('reads a platform rejection as permanent, keeping the provider wording', async () => {
    const { adapter } = adapterFor('platform_rejection');
    const outcome = await adapter.publish(
      publishRequest(SECRET, 'ayrshare', { target: target({ platformId: 'youtube' }) }),
    );

    expect(outcome.kind).toBe('permanent');
    if (outcome.kind !== 'permanent') return;
    expect(outcome.message).toContain('title exceeds the maximum allowed length');
  });

  it('will not guess when the response carries no platform verdict', async () => {
    const { adapter } = adapterFor('no_postids');
    const outcome = await adapter.publish(publishRequest(SECRET, 'ayrshare'));
    expect(outcome.kind).toBe('unknown');
  });

  it.each(['unauthorized', 'payment_required'])('reads %s as permanent', async (name) => {
    const { adapter } = adapterFor(name);
    const outcome = await adapter.publish(publishRequest(SECRET, 'ayrshare'));
    expect(outcome.kind).toBe('permanent');
  });

  it('reads a 429 as transient and honours Retry-After', async () => {
    const { adapter } = adapterFor('rate_limited');
    const before = Date.now();
    const outcome = await adapter.publish(publishRequest(SECRET, 'ayrshare'));

    expect(outcome.kind).toBe('transient');
    if (outcome.kind !== 'transient') return;
    expect(outcome.retryAt?.getTime()).toBeGreaterThanOrEqual(before + 30_000);
  });

  it('reads a 429 with no Retry-After as transient with no retryAt', async () => {
    const { adapter } = adapterFor('rate_limited_without_header');
    const outcome = await adapter.publish(publishRequest(SECRET, 'ayrshare'));

    expect(outcome.kind).toBe('transient');
    if (outcome.kind !== 'transient') return;
    expect(outcome.retryAt).toBeUndefined();
  });

  it('reads a 5xx as unknown, never transient: the request body was already sent', async () => {
    const { adapter } = adapterFor('server_error');
    const outcome = await adapter.publish(publishRequest(SECRET, 'ayrshare'));
    expect(outcome.kind).toBe('unknown');
  });

  it('refuses a platform it has no provider name for', async () => {
    const { adapter } = adapterFor('success_tiktok');
    const outcome = await adapter.publish(
      publishRequest(SECRET, 'ayrshare', { target: target({ platformId: 'mastodon' }) }),
    );
    expect(outcome.kind).toBe('permanent');
  });
});

describe('ayrshare: transport failures', () => {
  it('calls a refused connection transient', async () => {
    const adapter = createAyrshareAdapter({ fetch: failWith('ECONNREFUSED') });
    const outcome = await adapter.publish(publishRequest(SECRET, 'ayrshare'));
    expect(outcome.kind).toBe('transient');
  });

  it('calls a mid-flight reset unknown', async () => {
    const adapter = createAyrshareAdapter({ fetch: failWith('ECONNRESET') });
    const outcome = await adapter.publish(publishRequest(SECRET, 'ayrshare'));
    expect(outcome.kind).toBe('unknown');
  });

  it('calls its own timeout unknown', async () => {
    const adapter = createAyrshareAdapter({ fetch: neverAnswers() });
    const outcome = await adapter.publish(publishRequest(SECRET, 'ayrshare', { timeoutMs: 20 }));
    expect(outcome.kind).toBe('unknown');
  });
});

describe('ayrshare: the request we send', () => {
  it('sends attemptRef as idempotencyKey and maps the platform name', async () => {
    const { adapter, stub } = adapterFor('success_tiktok');
    await adapter.publish(publishRequest(SECRET, 'ayrshare'));

    const call = stub.calls[0];
    expect(call?.url).toBe('https://api.ayrshare.com/api/post');

    const body = JSON.parse(String(call?.init?.body)) as Record<string, unknown>;
    expect(body['idempotencyKey']).toBe('11111111-1111-4111-8111-111111111111');
    expect(body['platforms']).toEqual(['tiktok']);
    expect(body['isVideo']).toBe(true);
    expect(body['mediaUrls']).toEqual(['https://media.test/signed/clip.mp4']);
  });

  it('maps x to the provider spelling', async () => {
    const { adapter, stub } = adapterFor('success_tiktok');
    await adapter.publish(
      publishRequest(SECRET, 'ayrshare', { target: target({ platformId: 'x' }) }),
    );

    const body = JSON.parse(String(stub.calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body['platforms']).toEqual(['twitter']);
  });

  it('sends youTubeOptions only when a title exists', async () => {
    const withTitle = adapterFor('success_youtube');
    await withTitle.adapter.publish(
      publishRequest(SECRET, 'ayrshare', {
        target: target({ platformId: 'youtube', title: 'Episode 12' }),
      }),
    );
    const sent = JSON.parse(String(withTitle.stub.calls[0]?.init?.body)) as Record<string, unknown>;
    expect(sent['youTubeOptions']).toEqual({ title: 'Episode 12' });

    const without = adapterFor('success_youtube');
    await without.adapter.publish(
      publishRequest(SECRET, 'ayrshare', {
        target: target({ platformId: 'youtube', title: null }),
      }),
    );
    const bare = JSON.parse(String(without.stub.calls[0]?.init?.body)) as Record<string, unknown>;
    expect(bare['youTubeOptions']).toBeUndefined();
  });
});

describe('ayrshare: lookup can recognise but never prove absence', () => {
  it('finds an unambiguous single match', async () => {
    const { adapter } = adapterFor('single_match', histories);
    const outcome = await adapter.lookup(lookupRequest(SECRET, 'ayrshare'));

    expect(outcome.kind).toBe('found');
    if (outcome.kind !== 'found') return;
    expect(outcome.platformPostId).toBe('7300000000000000000');
  });

  it('answers unknown when two posts share the caption', async () => {
    const { adapter } = adapterFor('two_identical_captions', histories);
    expect((await adapter.lookup(lookupRequest(SECRET, 'ayrshare'))).kind).toBe('unknown');
  });

  it('answers unknown for a match that is still pending', async () => {
    const { adapter } = adapterFor('single_match_still_pending', histories);
    expect((await adapter.lookup(lookupRequest(SECRET, 'ayrshare'))).kind).toBe('unknown');
  });

  it('answers unknown — not absent — when nothing matches', async () => {
    const { adapter } = adapterFor('no_match', histories);
    expect((await adapter.lookup(lookupRequest(SECRET, 'ayrshare'))).kind).toBe('unknown');
  });

  it('answers unknown for an empty history', async () => {
    const { adapter } = adapterFor('empty', histories);
    expect((await adapter.lookup(lookupRequest(SECRET, 'ayrshare'))).kind).toBe('unknown');
  });

  it('never answers absent, for any recorded history shape (D-084)', async () => {
    for (const name of Object.keys(histories)) {
      const { adapter } = adapterFor(name, histories);
      const outcome = await adapter.lookup(lookupRequest(SECRET, 'ayrshare'));
      expect(outcome.kind, `history fixture ${name}`).not.toBe('absent');
    }

    for (const fetchStub of [failWith('ECONNREFUSED'), neverAnswers()]) {
      const adapter = createAyrshareAdapter({ fetch: fetchStub });
      const outcome = await adapter.lookup(lookupRequest(SECRET, 'ayrshare', { timeoutMs: 20 }));
      expect(outcome.kind).not.toBe('absent');
    }
  });
});

describe('ayrshare: connection health', () => {
  const check = {
    credential: { kind: 'aggregator_profile' as const, provider: 'ayrshare', secret: SECRET },
    platformId: 'tiktok',
    externalAccountId: 'test-creator',
    timeoutMs: 5_000,
  };

  it('reports a healthy linked account active', async () => {
    const { adapter } = adapterFor('active', usersFixtures);
    expect((await adapter.checkConnection(check)).kind).toBe('active');
  });

  it('reports an account near its refresh deadline as expiring', async () => {
    const { adapter } = adapterFor('expiring_soon', usersFixtures);
    const health = await adapter.checkConnection(check);

    expect(health.kind).toBe('expiring');
    if (health.kind !== 'expiring') return;
    expect(health.message).toContain('3 days');
  });

  it('respects the configured warning window', async () => {
    const stub = respondWith(fixture(usersFixtures, 'expiring_soon'));
    const adapter = createAyrshareAdapter({ fetch: stub.fetch, warnBeforeRefreshDays: 1 });
    expect((await adapter.checkConnection(check)).kind).toBe('active');
  });

  it('reports a platform missing from activeSocialAccounts as revoked', async () => {
    const { adapter } = adapterFor('platform_unlinked', usersFixtures);
    expect((await adapter.checkConnection(check)).kind).toBe('revoked');
  });

  it('reads the omitted activeSocialAccounts field as nothing linked', async () => {
    const { adapter } = adapterFor('nothing_linked', usersFixtures);
    expect((await adapter.checkConnection(check)).kind).toBe('revoked');
  });

  it('answers unknown when it cannot ask', async () => {
    const adapter = createAyrshareAdapter({ fetch: failWith('ECONNREFUSED') });
    expect((await adapter.checkConnection(check)).kind).toBe('unknown');
  });
});

describe('ayrshare: declared capabilities', () => {
  it('serves no platform until one has been verified live (D-083)', () => {
    expect(createAyrshareAdapter().platforms).toEqual([]);
  });

  it('accepts an idempotency key but declares no reference lookup (D-084)', () => {
    const adapter = createAyrshareAdapter();
    expect(adapter.supportsIdempotencyKey).toBe(true);
    expect(adapter.supportsReferenceLookup).toBe(false);
  });
});

describe('ayrshare: credentials never reach raw or a message (rule 5)', () => {
  it('redacts a credential the provider echoed back', async () => {
    const { adapter } = adapterFor('echoes_credential');
    const outcome = await adapter.publish(publishRequest(SECRET, 'ayrshare'));

    const serialised = JSON.stringify(outcome);
    expect(serialised).not.toContain(SECRET);
    expect(serialised).toContain('[redacted]');
  });

  it('keeps the credential out of every outcome, for every fixture', async () => {
    for (const name of Object.keys(posts)) {
      const { adapter } = adapterFor(name);
      const outcome = await adapter.publish(publishRequest(SECRET, 'ayrshare'));
      expect(JSON.stringify(outcome), `post fixture ${name}`).not.toContain(SECRET);
    }
  });
});
