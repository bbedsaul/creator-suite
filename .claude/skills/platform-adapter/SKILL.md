---
name: platform-adapter
description: How to build or modify a Social Poster platform adapter — the layer that actually publishes to an aggregator (Upload-Post, Ayrshare) or directly to TikTok, YouTube, X, LinkedIn, Instagram, or Facebook Pages. Use this whenever you write or change adapter code, the fake adapter, error classification, retry behavior, reconciliation lookups, credential use during dispatch, or platform constraint specs, including during the S09 aggregator spike.
---

# Platform adapters

Adapters are where the outside world gets messy: rate limits, flaky uploads, vague errors, and responses that may or may not mean "posted". The dispatcher's exactly-once guarantee (D-012) depends on every adapter classifying outcomes honestly. When in doubt, an adapter says **unknown**, never success or transient.

## Interface

```ts
interface PlatformAdapter {
  readonly id: string;                 // 'fake' | 'ayrshare' | 'upload_post' | 'direct:tiktok'
  readonly platforms: readonly PlatformId[];

  publish(req: PublishRequest): Promise<PublishOutcome>;
  lookup(req: LookupRequest): Promise<LookupOutcome>;
  checkConnection(req: ConnectionCheckRequest): Promise<ConnectionHealth>;
}

type PublishOutcome =
  | { kind: 'success';   platformPostId: string; permalink?: string; raw: unknown }
  | { kind: 'transient'; message: string; retryAt?: Date; raw: unknown }
  | { kind: 'permanent'; message: string; raw: unknown }
  | { kind: 'unknown';   message: string; raw: unknown };

type LookupOutcome =
  | { kind: 'found';  platformPostId: string; permalink?: string }
  | { kind: 'absent' }                 // provably not posted: safe to retry
  | { kind: 'unknown' };
```

`PublishRequest` carries `attemptRef` (the `dispatch_attempts.id`), the decrypted credential, the target's content with overrides applied, and ready rendition URLs. Adapters never touch the database; the dispatcher does all state changes via `finish_dispatch`.

## Classification rules

Classify by what you can prove, not by HTTP status alone.

| Situation | Outcome |
|---|---|
| 2xx with a post id | `success` |
| 429 / 5xx / connection refused **before** the request body was sent | `transient` (use `Retry-After` for `retryAt`) |
| 4xx for content (too long, bad format, policy) | `permanent`, with the platform's message verbatim |
| 401/403 meaning the credential is dead | `permanent`, and the dispatcher also marks the connection for a health check |
| Timeout **after** the request was sent, socket reset mid-response, 5xx on a non-idempotent upload | **`unknown`** |
| Aggregator says "queued/processing" without a post id | Poll within the attempt's lease if the API supports it; if the lease would expire, `unknown` |

Never map `unknown` to `transient` "to be helpful". The dispatcher sends `unknown` to reconciliation, which calls `lookup(attemptRef)`; only `absent` makes a retry safe.

## Idempotency and lookup

- Pass `attemptRef` to the provider as its idempotency key or external reference if it supports one. Record in the adapter's README whether it does. This determines how often `lookup` can return `absent` instead of `unknown`, which is a scoring criterion in the S09 spike.
- If the provider has no reference field, `lookup` may match on (account, time window, caption hash), but it must return `unknown` rather than guess when more than one or zero-but-uncertain matches exist.

## Credentials

- Receive the decrypted credential from the dispatcher; never fetch or decrypt it yourself. Every decrypt is logged by the vault layer.
- Never log, echo, or include a credential in `raw`, error messages, or thrown errors. Redact provider responses that echo headers.

## Limits are data

Platform constraints (text length, media counts, durations, aspect ratios, thread support) live in `poster.platform_constraints` as JSON specs, served by `GET /v1/platforms/constraints`. When an adapter learns a real limit, update the spec via a migration or seed, never a TS constant. CI greps for literal limits.

## Isolation

Each platform has its own dispatch loop with its own concurrency and timeouts (NFR-04). Adapters must:
- Set explicit per-request timeouts (never rely on defaults).
- Hold no shared global state or locks across platforms.
- Respect provider rate limits by returning `transient` with `retryAt`, not by sleeping inside `publish`.

## Testing

1. **Fake adapter first.** Every behavior gets a scripted fake scenario: success, transient ×N then success, permanent, hang past the lease, unknown then `lookup` found / absent / unknown.
2. **Contract tests per real adapter**, using recorded fixtures of real provider responses (scrub credentials) for each classification row above.
3. **Live smoke test** behind an env flag (`LIVE_ADAPTER_TESTS=1`), posting to test accounts only.

## Adding a new adapter checklist

- [ ] Implements all three methods; `platforms` lists only platforms actually verified.
- [ ] Classification table covered by fixture tests, including at least one `unknown` case.
- [ ] README: idempotency support, rate limits, known quirks, fixture refresh steps.
- [ ] Constraint specs updated as data.
- [ ] DECISIONS entry if it replaces or joins another adapter for a platform.
