/**
 * The platform adapter interface.
 *
 * Adapters are where the outside world gets messy. The dispatcher's exactly-once
 * guarantee (D-012) rests entirely on adapters classifying outcomes **honestly**:
 * when an adapter cannot prove what happened it must say `unknown`, never
 * `success` (which risks losing a post) and never `transient` (which risks
 * sending it twice). Only reconciliation may turn an `unknown` into a verdict.
 *
 * Adapters never touch the database. The dispatcher owns every state change and
 * makes it through `poster.finish_dispatch` (CLAUDE.md rule 2).
 */

/** What the adapter is allowed to see of a credential. */
export interface AdapterCredential {
  readonly kind: 'aggregator_profile' | 'oauth_token';
  readonly provider: string;
  /** Plaintext. Never log it, never echo it into `raw`, never put it in an error. */
  readonly secret: string;
}

export interface PublishTarget {
  readonly targetId: string;
  readonly platformId: string;
  /** The account on the platform, as the adapter knows it. */
  readonly externalAccountId: string;
  /** Caption and title with per-target overrides already applied. */
  readonly text: string | null;
  readonly title: string | null;
}

export interface Rendition {
  readonly mediaId: string;
  readonly kind: 'image' | 'video';
  readonly mimeType: string;
  /** Where the adapter can fetch the bytes. */
  readonly url: string;
  readonly durationS: number | null;
}

export interface PublishRequest {
  /**
   * The `dispatch_attempts.id`. Passed to the provider as its idempotency or
   * external reference where one is supported, which is what later makes
   * `lookup` able to answer `absent` instead of `unknown` (D-012).
   */
  readonly attemptRef: string;
  readonly credential: AdapterCredential;
  readonly target: PublishTarget;
  readonly renditions: readonly Rendition[];
  /** Hard deadline. Adapters must not rely on library defaults. */
  readonly timeoutMs: number;
}

export type PublishOutcome =
  | {
      readonly kind: 'success';
      readonly platformPostId: string;
      readonly permalink?: string;
      readonly raw: unknown;
    }
  | {
      readonly kind: 'transient';
      readonly message: string;
      readonly retryAt?: Date;
      readonly raw: unknown;
    }
  | { readonly kind: 'permanent'; readonly message: string; readonly raw: unknown }
  | { readonly kind: 'unknown'; readonly message: string; readonly raw: unknown };

export interface LookupRequest {
  readonly attemptRef: string;
  readonly credential: AdapterCredential;
  readonly target: PublishTarget;
  readonly timeoutMs: number;
}

export type LookupOutcome =
  | { readonly kind: 'found'; readonly platformPostId: string; readonly permalink?: string }
  /** Provably not posted. Only this makes a retry safe. */
  | { readonly kind: 'absent' }
  | { readonly kind: 'unknown' };

export interface ConnectionCheckRequest {
  readonly credential: AdapterCredential;
  readonly externalAccountId: string;
  readonly timeoutMs: number;
}

export type ConnectionHealth =
  | { readonly kind: 'active' }
  | { readonly kind: 'expiring'; readonly message: string }
  | { readonly kind: 'revoked'; readonly message: string }
  | { readonly kind: 'unknown'; readonly message: string };

export interface PlatformAdapter {
  /** 'fake' | 'ayrshare' | 'upload_post' | 'direct:tiktok' … */
  readonly id: string;
  /** Only platforms actually verified against this adapter. */
  readonly platforms: readonly string[];
  /** Whether the provider accepts `attemptRef` as an idempotency key (D-012). */
  readonly supportsIdempotencyKey: boolean;

  publish(request: PublishRequest): Promise<PublishOutcome>;
  lookup(request: LookupRequest): Promise<LookupOutcome>;
  checkConnection(request: ConnectionCheckRequest): Promise<ConnectionHealth>;
}

/** Maps a publish outcome to the `poster.attempt_outcome` enum value. */
export function attemptOutcomeFor(
  outcome: PublishOutcome,
): 'success' | 'transient' | 'permanent' | 'unknown' {
  return outcome.kind;
}
