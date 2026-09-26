/**
 * @suite/poster-client — the only way anything talks to the Poster API
 * (D-022, D-026): apps/*, services/clipper, services/trainer and the M1 demo
 * script all go through this SDK.
 *
 * The request and response *types* in ./schema.ts are generated from the
 * OpenAPI spec and must not be hand-edited (CLAUDE.md rule 13). This file is the
 * thin, hand-written runtime around them: it adds nothing to the wire contract,
 * it only supplies the base URL, the bearer token, and typed error handling.
 */
import createClient, { type Client, type Middleware } from 'openapi-fetch';
import type { paths } from './schema.js';

export type { paths, components, operations } from './schema.js';

/** Contract version the generated types were produced from. */
export const TARGET_CONTRACT_VERSION = '1.2' as const;

export interface PosterClientOptions {
  /** Service root, e.g. https://poster.example.com or http://localhost:8080. */
  baseUrl: string;
  /**
   * Supplies the bearer token per request. A function rather than a string
   * because app-mode tokens expire every 15 minutes and user-mode sessions
   * refresh, so a caller must be able to hand over a fresh one.
   */
  getToken?: () => string | undefined | Promise<string | undefined>;
  /** Injected in tests; defaults to the platform fetch. */
  fetch?: typeof globalThis.fetch;
}

export type PosterClient = Client<paths>;

/** The error envelope as it appears on the wire (contract §8). */
export interface PosterApiError {
  code: string;
  message: string;
  request_id: string;
  details?: { target_index: number; connection_id?: string; code: string }[];
}

/**
 * Thrown by `unwrap`. Carries the envelope so callers switch on `code` and can
 * quote `request_id` when something needs chasing.
 */
export class PosterError extends Error {
  constructor(
    readonly status: number,
    readonly error: PosterApiError,
  ) {
    super(`${error.code}: ${error.message}`);
    this.name = 'PosterError';
  }

  get requestId(): string {
    return this.error.request_id;
  }
}

export function createPosterClient(options: PosterClientOptions): PosterClient {
  const client = createClient<paths>({
    baseUrl: options.baseUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  if (options.getToken !== undefined) {
    const auth: Middleware = {
      async onRequest({ request }) {
        const token = await options.getToken?.();
        if (token !== undefined && token !== '') {
          request.headers.set('Authorization', `Bearer ${token}`);
        }
        return request;
      },
    };
    client.use(auth);
  }

  return client;
}

/**
 * Turns an openapi-fetch result into data or a thrown PosterError.
 *
 * openapi-fetch returns `{ data?, error? }` so that callers may handle failures
 * without exceptions. Most callers would rather not, so this is the opt-in
 * shortcut; the raw client stays available for the ones that do.
 */
export function unwrap<Data>(result: { data?: Data; error?: unknown; response: Response }): Data {
  if (result.error !== undefined) {
    const envelope = result.error as { error?: PosterApiError };
    const detail: PosterApiError = envelope.error ?? {
      code: 'internal_error',
      message: `Request failed with status ${String(result.response.status)}`,
      request_id: result.response.headers.get('x-request-id') ?? 'unknown',
    };
    throw new PosterError(result.response.status, detail);
  }
  if (result.data === undefined) {
    throw new PosterError(result.response.status, {
      code: 'internal_error',
      message: 'Response carried neither data nor an error envelope',
      request_id: result.response.headers.get('x-request-id') ?? 'unknown',
    });
  }
  return result.data;
}
