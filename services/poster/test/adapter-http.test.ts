/**
 * The shared adapter HTTP layer.
 *
 * Two things are worth testing on their own rather than through an adapter: the
 * three-way sent/not-sent/indeterminate verdict, which is the basis of every
 * `transient` vs `unknown` decision, and the scrubber, which is the only thing
 * standing between a provider that echoes a credential and a permanent row in
 * `dispatch_attempts.response`.
 */
import { describe, expect, it } from 'vitest';
import {
  adapterFetch,
  createRedactor,
  parseRetryAfter,
  scrubSecrets,
} from '../src/adapters/http.js';
import { failWith, neverAnswers } from './helpers/adapter-fixtures.js';

const ANY = { url: 'https://provider.test/x', method: 'GET' as const, headers: {}, timeoutMs: 100 };

describe('parseRetryAfter', () => {
  it('reads a delay in seconds', () => {
    expect(parseRetryAfter('120')).toBe(120_000);
  });

  it('reads an HTTP-date as a delay from now', () => {
    const now = Date.parse('2026-09-26T12:00:00Z');
    expect(parseRetryAfter('Sat, 26 Sep 2026 12:00:30 GMT', now)).toBe(30_000);
  });

  it('never returns a negative delay for a date in the past', () => {
    const now = Date.parse('2026-09-26T12:00:00Z');
    expect(parseRetryAfter('Sat, 26 Sep 2026 11:59:00 GMT', now)).toBe(0);
  });

  it('returns undefined for a missing or unparseable header', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

describe('adapterFetch: did the request reach the provider?', () => {
  it.each(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'])(
    'reports %s as not_sent',
    async (code) => {
      const result = await adapterFetch({ ...ANY, fetch: failWith(code) });
      expect(result.kind).toBe('not_sent');
    },
  );

  it.each(['ECONNRESET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET'])(
    'reports %s as indeterminate',
    async (code) => {
      const result = await adapterFetch({ ...ANY, fetch: failWith(code) });
      expect(result.kind).toBe('indeterminate');
    },
  );

  it('treats an unrecognised error code as indeterminate, not not_sent', async () => {
    // The conservative direction on purpose: a new Node error code costs a
    // reconciliation round-trip rather than risking a duplicate post.
    const result = await adapterFetch({ ...ANY, fetch: failWith('SOME_FUTURE_CODE') });
    expect(result.kind).toBe('indeterminate');
  });

  it('treats its own deadline as indeterminate', async () => {
    const result = await adapterFetch({ ...ANY, fetch: neverAnswers(), timeoutMs: 20 });
    expect(result.kind).toBe('indeterminate');
  });

  it('returns a non-JSON body as text rather than failing', async () => {
    const fetch = (() =>
      Promise.resolve(
        new Response('<html>502 Bad Gateway</html>', { status: 502 }),
      )) as typeof globalThis.fetch;

    const result = await adapterFetch({ ...ANY, fetch });
    expect(result.kind).toBe('response');
    if (result.kind !== 'response') return;
    expect(result.response.status).toBe(502);
    expect(result.response.body).toEqual({ text: '<html>502 Bad Gateway</html>' });
  });

  it('treats an empty body as an empty object', async () => {
    const fetch = (() =>
      Promise.resolve(new Response('', { status: 200 }))) as typeof globalThis.fetch;

    const result = await adapterFetch({ ...ANY, fetch });
    expect(result.kind).toBe('response');
    if (result.kind !== 'response') return;
    expect(result.response.body).toEqual({});
  });

  it('never throws, whatever the transport does', async () => {
    const fetch = (() => Promise.reject('not even an Error')) as typeof globalThis.fetch;
    await expect(adapterFetch({ ...ANY, fetch })).resolves.toMatchObject({
      kind: 'indeterminate',
    });
  });
});

describe('scrubSecrets', () => {
  it('replaces the secret wherever it appears in a string', () => {
    const scrubbed = scrubSecrets({ message: 'bad key sk_abc123' }, ['sk_abc123']);
    expect(scrubbed).toEqual({ message: 'bad key [redacted]' });
  });

  it('replaces every occurrence, not just the first', () => {
    const scrubbed = scrubSecrets('sk_abc123 and again sk_abc123', ['sk_abc123']);
    expect(scrubbed).toBe('[redacted] and again [redacted]');
  });

  it('redacts secret-shaped field names even when the value is new to us', () => {
    const scrubbed = scrubSecrets({ api_key: 'something we have never seen' }, ['other']);
    expect(scrubbed).toEqual({ api_key: '[redacted]' });
  });

  it('reaches into nested objects and arrays', () => {
    const scrubbed = scrubSecrets(
      { errors: [{ detail: 'used sk_abc123', nested: { token: 'x' } }] },
      ['sk_abc123'],
    );
    expect(JSON.stringify(scrubbed)).not.toContain('sk_abc123');
    expect(JSON.stringify(scrubbed)).not.toContain('"x"');
  });

  it('leaves everything else alone', () => {
    const body = { status: 'error', code: 137, ok: false, nothing: null };
    expect(scrubSecrets(body, ['sk_abc123'])).toEqual(body);
  });

  it('ignores an empty secret, which would otherwise redact every character', () => {
    expect(scrubSecrets({ message: 'hello' }, [''])).toEqual({ message: 'hello' });
  });
});

describe('createRedactor', () => {
  it('scrubs values and text with the same secret list', () => {
    const redact = createRedactor(['sk_abc123']);
    expect(redact.text('quoting sk_abc123')).toBe('quoting [redacted]');
    expect(redact.value({ note: 'sk_abc123' })).toEqual({ note: '[redacted]' });
  });
});
