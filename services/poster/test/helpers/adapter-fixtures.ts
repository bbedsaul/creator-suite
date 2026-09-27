/**
 * Replays recorded provider responses through an injected `fetch`.
 *
 * The adapters take `fetch` as an option for exactly this: the classification
 * table is tested against real response *shapes* without a network, and the
 * fixtures can later be re-recorded from live calls without touching a test.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AdapterCredential,
  LookupRequest,
  PublishRequest,
  PublishTarget,
  Rendition,
} from '../../src/adapters/adapter.js';

const FIXTURE_ROOT = join(import.meta.dirname, '..', 'fixtures', 'adapters');

export interface RecordedResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export function loadFixtures(
  provider: 'upload-post' | 'ayrshare',
  file: string,
): Record<string, RecordedResponse> {
  const path = join(FIXTURE_ROOT, provider, `${file}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, RecordedResponse>;
}

export interface StubbedFetch {
  readonly fetch: typeof globalThis.fetch;
  /** Every call, in order, so a test can assert what we sent. */
  readonly calls: { url: string; init: RequestInit | undefined }[];
}

/** A fetch that always answers with one recorded response. */
export function respondWith(recorded: RecordedResponse): StubbedFetch {
  const calls: { url: string; init: RequestInit | undefined }[] = [];

  const fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(
      new Response(JSON.stringify(recorded.body), {
        status: recorded.status,
        headers: { 'content-type': 'application/json', ...recorded.headers },
      }),
    );
  }) as typeof globalThis.fetch;

  return { fetch, calls };
}

/** A fetch that fails at the transport layer with a given Node error code. */
export function failWith(code: string, message = 'transport failure'): typeof globalThis.fetch {
  return (() => {
    const error = new Error(message);
    // undici nests the real code under `cause`; both shapes must be handled.
    (error as { cause?: unknown }).cause = Object.assign(new Error(message), { code });
    return Promise.reject(error);
  }) as typeof globalThis.fetch;
}

/** A fetch that never answers, so the adapter's own deadline is what ends it. */
export function neverAnswers(): typeof globalThis.fetch {
  return ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => {
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        },
        { once: true },
      );
    })) as typeof globalThis.fetch;
}

export const TEST_SECRET = 'up_live_SECRETVALUE';
export const AYRSHARE_TEST_SECRET = 'AYR_SECRETVALUE';

export function credential(secret: string, provider: string): AdapterCredential {
  return { kind: 'aggregator_profile', provider, secret };
}

export function videoRendition(overrides: Partial<Rendition> = {}): Rendition {
  return {
    mediaId: 'md-1',
    kind: 'video',
    mimeType: 'video/mp4',
    url: 'https://media.test/signed/clip.mp4',
    durationS: 60,
    ...overrides,
  };
}

export function target(overrides: Partial<PublishTarget> = {}): PublishTarget {
  return {
    targetId: '22222222-2222-4222-8222-222222222222',
    platformId: 'tiktok',
    externalAccountId: 'test-creator',
    text: 'Behind the scenes of episode 12',
    title: null,
    ...overrides,
  };
}

export const ATTEMPT_REF = '11111111-1111-4111-8111-111111111111';

export function publishRequest(
  secret: string,
  provider: string,
  overrides: Partial<PublishRequest> = {},
): PublishRequest {
  return {
    attemptRef: ATTEMPT_REF,
    credential: credential(secret, provider),
    target: target(),
    renditions: [videoRendition()],
    timeoutMs: 5_000,
    ...overrides,
  };
}

export function lookupRequest(
  secret: string,
  provider: string,
  overrides: Partial<LookupRequest> = {},
): LookupRequest {
  return {
    attemptRef: ATTEMPT_REF,
    credential: credential(secret, provider),
    target: target(),
    timeoutMs: 5_000,
    ...overrides,
  };
}
