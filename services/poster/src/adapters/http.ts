/**
 * The HTTP layer both aggregator adapters share.
 *
 * Its job is narrow and load-bearing: decide whether a failed request **reached
 * the provider**. That distinction is the whole difference between a safe retry
 * and a double post (D-012), and it cannot be recovered later — by the time the
 * dispatcher sees an outcome, the socket is gone.
 *
 * So the result type has three arms, not two:
 *
 *   - `response`      the provider answered; the adapter classifies the body.
 *   - `not_sent`      the connection never established, so nothing was posted.
 *                     This is the *only* transport failure a caller may call
 *                     `transient`.
 *   - `indeterminate` bytes went out and the answer did not come back. The post
 *                     may exist. The only honest outcome is `unknown`.
 *
 * Nothing here retries. A library that retries on our behalf would re-send a
 * publish the dispatcher believes was attempted once, which rule 3 forbids —
 * which is also why neither adapter uses a provider SDK.
 */

export interface AdapterHttpResponse {
  readonly status: number;
  /** Parsed JSON, or `{ text }` when the body was not JSON. Never credentials. */
  readonly body: unknown;
  /** From `Retry-After`, in milliseconds, when the provider sent one. */
  readonly retryAfterMs: number | undefined;
}

export type AdapterHttpResult =
  | { readonly kind: 'response'; readonly response: AdapterHttpResponse }
  | { readonly kind: 'not_sent'; readonly message: string }
  | { readonly kind: 'indeterminate'; readonly message: string };

/**
 * Error codes that prove the request body never left us.
 *
 * Deliberately a short allowlist rather than a denylist: an unrecognised failure
 * is treated as indeterminate, so a new Node error code costs us a reconciliation
 * round-trip instead of a duplicate post. Getting this list wrong in the
 * conservative direction is cheap; getting it wrong the other way is not.
 */
const NEVER_SENT_CODES = new Set([
  'ENOTFOUND', // DNS did not resolve
  'EAI_AGAIN', // DNS temporary failure
  'ECONNREFUSED', // nothing listening
  'UND_ERR_CONNECT_TIMEOUT', // TCP connect never completed
  'ERR_TLS_CERT_ALTNAME_INVALID', // TLS rejected before the request
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

/** Walks the `cause` chain, because undici nests the real code one or two deep. */
function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'request failed';
}

/** Seconds or an HTTP-date, per RFC 9110. Returns undefined for anything else. */
export function parseRetryAfter(
  header: string | null,
  now: number = Date.now(),
): number | undefined {
  if (header === null) return undefined;

  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

export interface AdapterRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  /** Only the two shapes the adapters actually send. */
  readonly body?: string | FormData;
  readonly timeoutMs: number;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Performs one request. Never throws: every failure becomes a result arm, so an
 * adapter cannot accidentally let a transport error escape as an exception the
 * dispatcher would have to guess about.
 */
export async function adapterFetch(request: AdapterRequest): Promise<AdapterHttpResult> {
  const doFetch = request.fetch ?? globalThis.fetch;

  let response: Response;
  try {
    response = await doFetch(request.url, {
      method: request.method,
      headers: { ...request.headers },
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: AbortSignal.timeout(request.timeoutMs),
    });
  } catch (error) {
    const code = errorCode(error);
    if (code !== undefined && NEVER_SENT_CODES.has(code)) {
      return { kind: 'not_sent', message: `${code}: ${errorMessage(error)}` };
    }
    // Includes our own deadline firing. A timeout is not evidence of absence:
    // the provider may have accepted the upload and been slow to answer.
    return {
      kind: 'indeterminate',
      message: `${code ?? 'transport'}: ${errorMessage(error)}`,
    };
  }

  // Reading the body can fail on its own (reset mid-response). That is still
  // indeterminate: we have a status line but not the verdict.
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    return {
      kind: 'indeterminate',
      message: `response body unreadable after ${String(response.status)}: ${errorMessage(error)}`,
    };
  }

  let body: unknown;
  try {
    body = text === '' ? {} : (JSON.parse(text) as unknown);
  } catch {
    body = { text };
  }

  return {
    kind: 'response',
    response: {
      status: response.status,
      body,
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
    },
  };
}

/**
 * Removes secrets from anything bound for `raw`, which is persisted to
 * `dispatch_attempts.response` and therefore permanent (rule 5).
 *
 * Two passes, because either alone leaves a hole: field names are stripped so a
 * provider that echoes our credential under a new key is still covered, and the
 * literal values are replaced so a credential appearing inside a *message* string
 * is caught too.
 */
const SECRET_KEY = /key|token|secret|password|authorization|credential/i;

/**
 * Both scrubbing entry points an adapter needs, built once from one secret list.
 *
 * `text` exists because the first version of this only scrubbed `raw`, and a
 * provider that quoted our API key back inside its error message put that key
 * straight into `post_targets.failure_reason` and from there into a webhook. A
 * message is as public as a payload, so both go through here (rule 5).
 */
export interface Redactor {
  value(value: unknown): unknown;
  text(value: string): string;
}

export function createRedactor(secrets: readonly string[]): Redactor {
  return {
    value: (value) => scrubSecrets(value, secrets),
    text: (value) => scrubSecrets(value, secrets) as string,
  };
}

export function scrubSecrets(value: unknown, secrets: readonly string[]): unknown {
  const present = secrets.filter((secret) => secret.length > 0);

  function walk(node: unknown): unknown {
    if (typeof node === 'string') {
      return present.reduce<string>((text, secret) => text.split(secret).join('[redacted]'), node);
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        out[key] = SECRET_KEY.test(key) ? '[redacted]' : walk(child);
      }
      return out;
    }
    return node;
  }

  return walk(value);
}
