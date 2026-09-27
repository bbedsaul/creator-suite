/**
 * Upload-Post adapter.
 *
 * Built during the S09 spike alongside the Ayrshare adapter so the choice between
 * them rests on two working implementations rather than on documentation
 * (D-083). Neither is registered for any platform until it has actually posted;
 * `platforms` defaults to empty on purpose, so this file cannot take over TikTok
 * from the fake by being imported.
 *
 * What makes this provider interesting for us is one endpoint:
 * `GET /api/uploadposts/history?external_id=…`. We send `attemptRef` as
 * `external_id`, so reconciliation can ask "did attempt X post?" and get a real
 * answer. That is the difference between an ambiguous dispatch that recovers by
 * itself and one that needs a human (D-084).
 *
 * Endpoints used (documented 2026-09-26):
 *   POST /api/upload                       multipart, sync
 *   GET  /api/uploadposts/history          exact external_id filter
 *   GET  /api/uploadposts/users            connected accounts + reauth_required
 */
import type {
  ConnectionCheckRequest,
  ConnectionHealth,
  LookupOutcome,
  LookupRequest,
  PlatformAdapter,
  PublishOutcome,
  PublishRequest,
} from './adapter.js';
import { adapterFetch, createRedactor, type AdapterHttpResponse, type Redactor } from './http.js';
import { UPLOAD_POST_PLATFORMS } from './platform-map.js';

export const UPLOAD_POST_ADAPTER_ID = 'upload_post';

export interface UploadPostAdapterOptions {
  /** Base URL, overridden in tests. No trailing slash. */
  readonly baseUrl?: string;
  /**
   * Platforms this adapter is allowed to serve. Empty until a live post has
   * proved one works (D-083) — the skill's rule that `platforms` lists only
   * verified platforms, made structural instead of a comment.
   */
  readonly platforms?: readonly string[];
  readonly fetch?: typeof globalThis.fetch;
}

/** Per-platform entry in a sync upload response. */
interface PlatformResult {
  readonly success?: unknown;
  readonly url?: unknown;
  readonly post_id?: unknown;
  readonly video_id?: unknown;
  readonly publish_id?: unknown;
  readonly container_id?: unknown;
  readonly video_urn?: unknown;
  readonly error?: unknown;
  readonly skipped?: unknown;
  readonly skip_reason?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

/** The provider spreads the platform's post id across several optional names. */
function platformPostIdOf(result: PlatformResult): string | undefined {
  return (
    asString(result.post_id) ??
    asString(result.video_id) ??
    asString(result.publish_id) ??
    asString(result.video_urn) ??
    asString(result.container_id)
  );
}

function messageOf(body: unknown, fallback: string): string {
  const record = asRecord(body);
  return asString(record?.['message']) ?? asString(record?.['error']) ?? fallback;
}

export function createUploadPostAdapter(options: UploadPostAdapterOptions = {}): PlatformAdapter {
  const baseUrl = options.baseUrl ?? 'https://api.upload-post.com';

  function authHeaders(secret: string): Record<string, string> {
    return { authorization: `Apikey ${secret}` };
  }

  return {
    id: UPLOAD_POST_ADAPTER_ID,
    platforms: options.platforms ?? [],
    // `Idempotency-Key` on the upload, plus `external_id` echoed everywhere.
    supportsIdempotencyKey: true,
    // GET /api/uploadposts/history?external_id= is an exact-match filter.
    supportsReferenceLookup: true,

    async publish(request: PublishRequest): Promise<PublishOutcome> {
      const providerPlatform = UPLOAD_POST_PLATFORMS[request.target.platformId];
      if (providerPlatform === undefined) {
        return {
          kind: 'permanent',
          message: `upload-post has no platform name for ${request.target.platformId}`,
          raw: { adapter: UPLOAD_POST_ADAPTER_ID },
        };
      }

      const video = request.renditions.find((rendition) => rendition.kind === 'video');
      if (video === undefined) {
        // Not a content rule we invented: this adapter's upload endpoint is the
        // video endpoint. A target with no video cannot use it at all.
        return {
          kind: 'permanent',
          message: 'no video rendition to upload',
          raw: { adapter: UPLOAD_POST_ADAPTER_ID },
        };
      }

      const form = new FormData();
      form.set('user', request.target.externalAccountId);
      form.append('platform[]', providerPlatform);
      form.set('video', video.url);
      form.set('external_id', request.attemptRef);
      // Sent, not derived. A title the provider requires and we do not have is
      // the provider's rejection to make, not ours to invent (rule 9).
      if (request.target.title !== null) form.set('title', request.target.title);
      if (request.target.text !== null) form.set('description', request.target.text);

      const result = await adapterFetch({
        url: `${baseUrl}/api/upload`,
        method: 'POST',
        headers: {
          ...authHeaders(request.credential.secret),
          'idempotency-key': request.attemptRef,
        },
        body: form,
        timeoutMs: request.timeoutMs,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });

      // Transport messages are redacted too: they quote whatever the runtime put
      // in the error, and a message is as public as a payload (rule 5).
      const redact = createRedactor([request.credential.secret]);

      if (result.kind === 'not_sent') {
        return {
          kind: 'transient',
          message: redact.text(result.message),
          raw: { adapter: UPLOAD_POST_ADAPTER_ID, transport: 'not_sent' },
        };
      }
      if (result.kind === 'indeterminate') {
        return {
          kind: 'unknown',
          message: redact.text(result.message),
          raw: { adapter: UPLOAD_POST_ADAPTER_ID, transport: 'indeterminate' },
        };
      }

      return classifyUpload(result.response, providerPlatform, redact);
    },

    async lookup(request: LookupRequest): Promise<LookupOutcome> {
      const providerPlatform = UPLOAD_POST_PLATFORMS[request.target.platformId];
      if (providerPlatform === undefined) return { kind: 'unknown' };

      const url = new URL(`${baseUrl}/api/uploadposts/history`);
      url.searchParams.set('external_id', request.attemptRef);
      url.searchParams.set('limit', '10');

      const result = await adapterFetch({
        url: url.toString(),
        method: 'GET',
        headers: authHeaders(request.credential.secret),
        timeoutMs: request.timeoutMs,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });

      // Being unable to ask is not evidence of absence (D-074).
      if (result.kind !== 'response') return { kind: 'unknown' };
      if (result.response.status !== 200) return { kind: 'unknown' };

      const body = asRecord(result.response.body);
      const history = body?.['history'];
      const inProgress = body?.['in_progress'];
      if (!Array.isArray(history)) return { kind: 'unknown' };

      for (const entry of history) {
        const record = asRecord(entry);
        if (record === undefined) continue;
        if (record['platform'] !== providerPlatform) continue;

        if (record['success'] === true) {
          const id = asString(record['platform_post_id']);
          const permalink = asString(record['post_url']);
          // A recorded success is a post that exists, so it is `found` even when
          // the provider did not name it. `platformPostId` is optional for exactly
          // this case; substituting our own attempt id would write something that
          // is not the platform's id into the column that means that.
          return {
            kind: 'found',
            ...(id === undefined ? {} : { platformPostId: id }),
            ...(permalink === undefined ? {} : { permalink }),
          };
        }
        if (record['success'] === false) {
          // The provider recorded our attempt and recorded that it failed. That
          // is a proof of absence, which is what makes a retry safe (D-074).
          return { kind: 'absent' };
        }
      }

      // Nothing recorded. Absence of a record is only evidence once the provider
      // has stopped working on it — an upload still in flight would also show no
      // history row, and calling that `absent` is exactly how a double post
      // happens (D-084).
      if (Array.isArray(inProgress) && inProgress.length > 0) return { kind: 'unknown' };
      return { kind: 'absent' };
    },

    async checkConnection(request: ConnectionCheckRequest): Promise<ConnectionHealth> {
      const result = await adapterFetch({
        url: `${baseUrl}/api/uploadposts/users`,
        method: 'GET',
        headers: authHeaders(request.credential.secret),
        timeoutMs: request.timeoutMs,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });

      if (result.kind !== 'response') return { kind: 'unknown', message: result.message };
      if (result.response.status !== 200) {
        return {
          kind: 'unknown',
          message: `users returned ${String(result.response.status)}`,
        };
      }

      const body = asRecord(result.response.body);
      const profiles = body?.['profiles'];
      if (!Array.isArray(profiles))
        return { kind: 'unknown', message: 'unreadable users response' };

      const profile = profiles
        .map(asRecord)
        .find((entry) => entry?.['username'] === request.externalAccountId);
      if (profile === undefined) {
        return { kind: 'revoked', message: 'no such profile at the provider' };
      }

      const providerPlatform = UPLOAD_POST_PLATFORMS[request.platformId];
      if (providerPlatform === undefined) {
        return { kind: 'unknown', message: `no provider name for ${request.platformId}` };
      }

      const accounts = asRecord(profile['social_accounts']);
      const account = accounts?.[providerPlatform];
      // The provider represents "not linked" as a missing key *or* an empty
      // string, so both have to count as revoked.
      if (account === undefined || account === null || account === '') {
        return { kind: 'revoked', message: `${providerPlatform} is not linked to this profile` };
      }

      const details = asRecord(account);
      if (details?.['reauth_required'] === true) {
        // Not `expiring`: the provider says it cannot publish until reconnected,
        // which is the same operational state as revoked.
        return { kind: 'revoked', message: `${providerPlatform} needs to be reconnected` };
      }

      return { kind: 'active' };
    },
  };
}

/**
 * Maps one upload response to an outcome.
 *
 * Exported for the fixture tests, which drive every row of this table directly
 * rather than through a stubbed fetch, so a classification change cannot pass by
 * being untested.
 */
export function classifyUpload(
  response: AdapterHttpResponse,
  providerPlatform: string,
  redact: Redactor,
): PublishOutcome {
  const raw = redact.value(response.body);
  const body = asRecord(response.body);

  switch (response.status) {
    case 200: {
      const results = asRecord(body?.['results']);
      const entry = asRecord(results?.[providerPlatform]) as PlatformResult | undefined;

      if (entry === undefined) {
        // 200 with nothing about the platform we asked for. Either the provider
        // accepted it asynchronously or the shape changed; both are unreadable,
        // and unreadable is `unknown`, never success.
        return {
          kind: 'unknown',
          message: `no result for ${providerPlatform} in a 200 response`,
          raw,
        };
      }

      if (entry.success === true) {
        // The provider gave an explicit per-platform verdict, so this is a post.
        // Both identifiers are optional: `unknown` here would send a real post to
        // reconciliation, and reconciliation would only confirm what we were just
        // told.
        const platformPostId = platformPostIdOf(entry);
        const permalink = asString(entry.url);
        return {
          kind: 'success',
          ...(platformPostId === undefined ? {} : { platformPostId }),
          ...(permalink === undefined ? {} : { permalink }),
          raw,
        };
      }

      if (entry.skipped === true) {
        return {
          kind: 'permanent',
          message: redact.text(asString(entry.skip_reason) ?? 'platform skipped by the provider'),
          raw,
        };
      }

      return {
        kind: 'permanent',
        message: redact.text(asString(entry.error) ?? `${providerPlatform} upload failed`),
        raw,
      };
    }

    // Accepted for later. We schedule ourselves and never send `scheduled_date`,
    // so this means the provider did something other than post now, and we
    // cannot say what.
    case 202:
      return {
        kind: 'unknown',
        message: redact.text(messageOf(response.body, 'unexpectedly scheduled')),
        raw,
      };

    case 400:
    case 401:
    case 403:
    case 404:
    case 422:
      return {
        kind: 'permanent',
        message: redact.text(messageOf(response.body, `http ${String(response.status)}`)),
        raw,
      };

    case 429:
      return {
        kind: 'transient',
        message: redact.text(messageOf(response.body, 'rate limited')),
        ...(response.retryAfterMs === undefined
          ? {}
          : { retryAt: new Date(Date.now() + response.retryAfterMs) }),
        raw,
      };

    default:
      // 5xx and anything else. The video was already on the wire, so a server
      // error does not tell us whether the post landed. `unknown` costs a
      // reconciliation round-trip; `transient` would risk a duplicate.
      return {
        kind: 'unknown',
        message: redact.text(messageOf(response.body, `http ${String(response.status)}`)),
        raw,
      };
  }
}
