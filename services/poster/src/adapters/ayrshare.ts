/**
 * Ayrshare adapter.
 *
 * The counterpart to the Upload-Post adapter in the S09 spike (D-083). Same
 * discipline, and the same rule that `platforms` stays empty until a live post
 * proves one works.
 *
 * The thing to understand about this provider is the asymmetry in its reference
 * handling. It **accepts** `idempotencyKey`, so a replayed request is refused —
 * but it publishes no way to *read* a post back by that key. `GET /post/{id}`
 * wants Ayrshare's own post id, which is precisely what we do not have when a
 * publish times out. So `lookup` cannot prove absence here, and this adapter
 * declares `supportsReferenceLookup: false` (D-084). The practical consequence:
 * an ambiguous dispatch through Ayrshare ends as
 * `failed/dispatch_outcome_unknown` and needs a human, where the same dispatch
 * through Upload-Post recovers by itself.
 *
 * Endpoints used (documented 2026-09-26):
 *   POST /api/post      idempotencyKey accepted; postIds[] carries id + postUrl
 *   GET  /api/history   filter by platform/status/date, but not by our reference
 *   GET  /api/user      activeSocialAccounts + refreshDaysRemaining per account
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
import { AYRSHARE_PLATFORMS } from './platform-map.js';

export const AYRSHARE_ADAPTER_ID = 'ayrshare';

/** "Duplicate or similar content posted within the same two day period." */
export const AYRSHARE_DUPLICATE_CODE = 137;

export interface AyrshareAdapterOptions {
  readonly baseUrl?: string;
  /** Empty until a live post has proved a platform works (D-083). */
  readonly platforms?: readonly string[];
  /**
   * Warn this many days before a linked account's token must be refreshed.
   * A policy choice, not a platform limit: it decides when we tell the user, not
   * what the platform permits.
   */
  readonly warnBeforeRefreshDays?: number;
  readonly fetch?: typeof globalThis.fetch;
}

const DEFAULT_WARN_BEFORE_REFRESH_DAYS = 14;

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

/** Collects `errors[].message` / top-level `message`, keeping the provider's words. */
function providerMessage(body: unknown, fallback: string): string {
  const record = asRecord(body);
  const errors = record?.['errors'];
  if (Array.isArray(errors)) {
    const messages = errors
      .map((error) => asRecord(error))
      .map((error) => asString(error?.['message']) ?? asString(error?.['status']))
      .filter((message): message is string => message !== undefined);
    if (messages.length > 0) return messages.join('; ');
  }
  return asString(record?.['message']) ?? fallback;
}

function hasErrorCode(body: unknown, code: number): boolean {
  const errors = asRecord(body)?.['errors'];
  if (!Array.isArray(errors)) return false;
  return errors.some((error) => asRecord(error)?.['code'] === code);
}

export function createAyrshareAdapter(options: AyrshareAdapterOptions = {}): PlatformAdapter {
  const baseUrl = options.baseUrl ?? 'https://api.ayrshare.com';
  const warnDays = options.warnBeforeRefreshDays ?? DEFAULT_WARN_BEFORE_REFRESH_DAYS;

  function authHeaders(secret: string): Record<string, string> {
    return { authorization: `Bearer ${secret}`, 'content-type': 'application/json' };
  }

  return {
    id: AYRSHARE_ADAPTER_ID,
    platforms: options.platforms ?? [],
    // Accepted on POST /post, per User Profile.
    supportsIdempotencyKey: true,
    // But there is no documented read path for it. This is the asymmetry.
    supportsReferenceLookup: false,

    async publish(request: PublishRequest): Promise<PublishOutcome> {
      const providerPlatform = AYRSHARE_PLATFORMS[request.target.platformId];
      if (providerPlatform === undefined) {
        return {
          kind: 'permanent',
          message: `ayrshare has no platform name for ${request.target.platformId}`,
          raw: { adapter: AYRSHARE_ADAPTER_ID },
        };
      }

      const mediaUrls = request.renditions.map((rendition) => rendition.url);
      const isVideo = request.renditions.some((rendition) => rendition.kind === 'video');

      const body: Record<string, unknown> = {
        // Media-only posts send an empty string, which the provider allows.
        post: request.target.text ?? '',
        platforms: [providerPlatform],
        mediaUrls,
        isVideo,
        idempotencyKey: request.attemptRef,
      };
      // Sent only when we have one: a title the provider requires and we lack is
      // the provider's rejection to make, not ours to invent (rule 9).
      if (request.target.platformId === 'youtube' && request.target.title !== null) {
        body['youTubeOptions'] = { title: request.target.title };
      }

      const result = await adapterFetch({
        url: `${baseUrl}/api/post`,
        method: 'POST',
        headers: authHeaders(request.credential.secret),
        body: JSON.stringify(body),
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
          raw: { adapter: AYRSHARE_ADAPTER_ID, transport: 'not_sent' },
        };
      }
      if (result.kind === 'indeterminate') {
        return {
          kind: 'unknown',
          message: redact.text(result.message),
          raw: { adapter: AYRSHARE_ADAPTER_ID, transport: 'indeterminate' },
        };
      }

      return classifyPost(result.response, providerPlatform, redact);
    },

    async lookup(request: LookupRequest): Promise<LookupOutcome> {
      const providerPlatform = AYRSHARE_PLATFORMS[request.target.platformId];
      if (providerPlatform === undefined) return { kind: 'unknown' };

      const url = new URL(`${baseUrl}/api/history`);
      url.searchParams.set('platforms', providerPlatform);
      url.searchParams.set('lastDays', '1');
      url.searchParams.set('limit', '100');

      const result = await adapterFetch({
        url: url.toString(),
        method: 'GET',
        headers: authHeaders(request.credential.secret),
        timeoutMs: request.timeoutMs,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });

      if (result.kind !== 'response' || result.response.status !== 200) return { kind: 'unknown' };

      const history = asRecord(result.response.body)?.['history'];
      if (!Array.isArray(history)) return { kind: 'unknown' };

      // All we can match on is the caption, because the provider offers no filter
      // for our reference. That is enough to *recognise* a post we made, and never
      // enough to prove we made none: an identical caption from the user, a
      // caption the provider rewrote, or a history read that simply lags would all
      // look the same. So this returns `found` or `unknown`, and never `absent`
      // (D-084) — matching the `supportsReferenceLookup: false` declaration above.
      const wanted = request.target.text ?? '';
      const matches = history
        .map(asRecord)
        .filter((entry): entry is Record<string, unknown> => entry !== undefined)
        .filter((entry) => asString(entry['post']) === (wanted === '' ? undefined : wanted));

      if (matches.length !== 1) return { kind: 'unknown' };

      const postIds = matches[0]?.['postIds'];
      if (!Array.isArray(postIds)) return { kind: 'unknown' };

      const posted = postIds
        .map(asRecord)
        .find((entry) => entry?.['platform'] === providerPlatform && entry['status'] === 'success');
      // A matching history row whose platform entry is not a success proves
      // nothing either way — the post may still be processing.
      if (posted === undefined) return { kind: 'unknown' };

      const id = asString(posted['id']);
      const permalink = asString(posted['postUrl']);
      return {
        kind: 'found',
        ...(id === undefined ? {} : { platformPostId: id }),
        ...(permalink === undefined ? {} : { permalink }),
      };
    },

    async checkConnection(request: ConnectionCheckRequest): Promise<ConnectionHealth> {
      const providerPlatform = AYRSHARE_PLATFORMS[request.platformId];
      if (providerPlatform === undefined) {
        return { kind: 'unknown', message: `no provider name for ${request.platformId}` };
      }

      const result = await adapterFetch({
        url: `${baseUrl}/api/user`,
        method: 'GET',
        headers: authHeaders(request.credential.secret),
        timeoutMs: request.timeoutMs,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });

      if (result.kind !== 'response') return { kind: 'unknown', message: result.message };
      if (result.response.status !== 200) {
        return { kind: 'unknown', message: `user returned ${String(result.response.status)}` };
      }

      const body = asRecord(result.response.body);
      const active = body?.['activeSocialAccounts'];
      // Documented: the field is omitted entirely when nothing is linked, so its
      // absence is a real answer rather than an unreadable response.
      const linked = Array.isArray(active) && active.includes(providerPlatform);
      if (!linked) {
        return { kind: 'revoked', message: `${providerPlatform} is not linked to this profile` };
      }

      const displayNames = body?.['displayNames'];
      const account = Array.isArray(displayNames)
        ? displayNames.map(asRecord).find((entry) => entry?.['platform'] === providerPlatform)
        : undefined;

      const remaining = account?.['refreshDaysRemaining'];
      if (typeof remaining === 'number' && remaining <= warnDays) {
        return {
          kind: 'expiring',
          message: `${providerPlatform} needs reauthorisation in ${String(remaining)} days`,
        };
      }

      return { kind: 'active' };
    },
  };
}

/**
 * Maps one POST /post response to an outcome.
 *
 * Exported so the fixture tests drive the table directly.
 */
export function classifyPost(
  response: AdapterHttpResponse,
  providerPlatform: string,
  redact: Redactor,
): PublishOutcome {
  const raw = redact.value(response.body);
  const body = asRecord(response.body);

  if (response.status === 200 || response.status === 201) {
    const status = asString(body?.['status']);
    const postIds = body?.['postIds'];
    const entry = Array.isArray(postIds)
      ? postIds.map(asRecord).find((item) => item?.['platform'] === providerPlatform)
      : undefined;

    if (entry?.['status'] === 'success') {
      // An explicit per-platform success is a post, named or not. Both identifiers
      // are optional on the outcome for exactly this reason.
      const id = asString(entry['id']);
      const permalink = asString(entry['postUrl']);
      return {
        kind: 'success',
        ...(id === undefined ? {} : { platformPostId: id }),
        ...(permalink === undefined ? {} : { permalink }),
        raw,
      };
    }

    // Duplicate-content rejection. On this attempt nothing was posted, so
    // `permanent` is the honest answer even though the body names an earlier
    // post: that earlier post may well be the user's own, and attributing it to
    // this target would invent a success. Rule 3 means publish is never retried
    // after an ambiguous outcome, so this does not cost us a recovery path.
    if (hasErrorCode(response.body, AYRSHARE_DUPLICATE_CODE)) {
      return {
        kind: 'permanent',
        message: redact.text(providerMessage(response.body, 'duplicate content rejected')),
        raw,
      };
    }

    if (entry?.['status'] === 'error') {
      return {
        kind: 'permanent',
        message: redact.text(providerMessage(response.body, 'post rejected')),
        raw,
      };
    }

    // "pending" (TikTok still processing) and anything else without a platform
    // verdict. There is no post id yet, and no way to ask for one later without
    // Ayrshare's own post id, so this is the case that ends as
    // dispatch_outcome_unknown.
    return {
      kind: 'unknown',
      message: redact.text(
        providerMessage(
          response.body,
          `no verdict for ${providerPlatform} (${status ?? 'no status'})`,
        ),
      ),
      raw,
    };
  }

  switch (response.status) {
    case 400:
    case 401:
    case 402:
    case 403:
    case 404:
    case 422:
      return {
        kind: 'permanent',
        message: redact.text(providerMessage(response.body, `http ${String(response.status)}`)),
        raw,
      };

    case 429:
      return {
        kind: 'transient',
        message: redact.text(providerMessage(response.body, 'rate limited')),
        ...(response.retryAfterMs === undefined
          ? {}
          : { retryAt: new Date(Date.now() + response.retryAfterMs) }),
        raw,
      };

    default:
      // 5xx: the request body was already sent. See the Upload-Post adapter for
      // why this is `unknown` rather than `transient`.
      return {
        kind: 'unknown',
        message: redact.text(providerMessage(response.body, `http ${String(response.status)}`)),
        raw,
      };
  }
}
