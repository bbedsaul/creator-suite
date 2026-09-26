/**
 * Per-app rate limiting (contract §2.1: 429 with Retry-After).
 *
 * Deliberately an interface with an in-process implementation (D-047). The
 * in-process bucket is exact for one API container and becomes N x the limit
 * across N containers, which is acceptable while M1 runs a single instance. When
 * horizontal scaling is real, a Postgres-backed implementation drops in behind
 * this interface without touching a handler. D-011 rules out Redis.
 */

export interface RateLimitVerdict {
  readonly allowed: boolean;
  /** Tokens left after this call. Surfaced for observability, not control flow. */
  readonly remaining: number;
  /** Whole seconds a rejected caller should wait, for the Retry-After header. */
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  /**
   * Charges one request against `key`, which is whatever the caller wants
   * counted: an app id, or an app id plus client IP for pre-auth endpoints.
   */
  consume(key: string, limitPerMinute: number): RateLimitVerdict;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export interface InMemoryRateLimiterOptions {
  /** Injectable clock so tests do not sleep. */
  readonly now?: () => number;
  /** Buckets idle this long are dropped, so a long-lived process cannot grow forever. */
  readonly idleEvictionMs?: number;
}

/**
 * Token bucket: capacity equals the per-minute limit and refills continuously at
 * limit/60 per second. A burst of `limit` is allowed, which is what callers
 * expect from a "per minute" limit, and recovery is gradual rather than a cliff
 * at the top of each minute.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;
  private readonly idleEvictionMs: number;

  constructor(options: InMemoryRateLimiterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idleEvictionMs = options.idleEvictionMs ?? 10 * 60 * 1000;
  }

  consume(key: string, limitPerMinute: number): RateLimitVerdict {
    if (!Number.isFinite(limitPerMinute) || limitPerMinute <= 0) {
      throw new RangeError(`limitPerMinute must be positive, received ${String(limitPerMinute)}`);
    }

    const nowMs = this.now();
    const perMs = limitPerMinute / 60_000;
    const bucket = this.buckets.get(key) ?? { tokens: limitPerMinute, lastRefillMs: nowMs };

    bucket.tokens = Math.min(limitPerMinute, bucket.tokens + (nowMs - bucket.lastRefillMs) * perMs);
    bucket.lastRefillMs = nowMs;

    let verdict: RateLimitVerdict;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      verdict = { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterSeconds: 0 };
    } else {
      // Always at least 1: Retry-After: 0 invites an immediate retry.
      const waitMs = (1 - bucket.tokens) / perMs;
      verdict = {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
      };
    }

    this.buckets.set(key, bucket);
    this.evictIdle(nowMs);
    return verdict;
  }

  /** Test seam: how many buckets are being tracked. */
  get size(): number {
    return this.buckets.size;
  }

  private evictIdle(nowMs: number): void {
    if (this.buckets.size < 1000) return;
    for (const [key, bucket] of this.buckets) {
      if (nowMs - bucket.lastRefillMs > this.idleEvictionMs) this.buckets.delete(key);
    }
  }
}
