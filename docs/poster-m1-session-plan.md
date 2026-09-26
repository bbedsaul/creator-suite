# Social Poster — Milestones & M1 Session Plan

*2026-09-26. The Milestones and Metrics sections below replace the unrecovered §10 and §11 of `social-poster-prd.md`. Paste them in.*

## §10 Milestones

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M1: Publish Core** | Schema, internal API (auth, media, posts, cancel/patch, constraints), constraint engine, adapter interface + fake + one aggregator adapter, per-platform dispatcher, reconciliation, webhook outbox | An API client submits a scheduled video post to TikTok and YouTube. It posts within 60 s of `schedule_at`, and signed webhooks arrive. Killing the worker mid-dispatch produces zero double-posts across 100 chaos runs. |
| **M2: Connections & Consent** | Connect/disconnect via the aggregator, health checks, revoke → pause → reconnect → resume, scope-request consent screen, grants, remaining launch platforms | A revoked connection pauses its queue. Reconnecting inside the grace window resumes it, and outside the window it fails with `token_revoked_expired`. A second app sees only the scopes it was granted. |
| **M3: Composer** | `apps/poster-web` SPA (onboarding, composer, queue/history, connections screen) on the Creator Suite design tokens, using only `poster-client` and user-mode auth | A new user connects an account and schedules a first post in under 2 minutes. |
| **M4: Self-Serve & Ops** | Stripe billing (accounts + post volume), usage attribution for suite apps, admin views, suspension, retention | A stranger signs up, pays, and has posts go out with zero operator involvement. Admin can suspend a user and see per-platform success rates. |

Build order is Poster → Clipper → Trainer (D-006). Clipper M2 (Review & Publish) depends on Poster M1 and M2; the Trainer's promotion milestone (Trainer M4) comes after that.

## §11 Success Metrics

- **Punctuality:** p95 dispatch lag under 60 s, and none early (NFR-01).
- **Double-posts:** 0, tracked as an alert rather than a rate (NFR-02).
- **Dispatch success rate** per platform, and **`dispatch_outcome_unknown` count** (should trend to ~0).
- **Connection health:** revocations per 100 connections per month, and the reconnect rate within the grace window.
- **Aggregator cost per posted target.**
- **Activation:** % of signups with one connected account and one scheduled post in their first session.
- **Trial-to-paid conversion; suite-app share of post volume.**

---

## M1 Sessions

Each session: load the context block, do the tasks, prove the acceptance criteria, update DECISIONS.md if needed, commit, tag `poster-m1-sNN`.

### S01: Monorepo bootstrap
**Context:** CLAUDE.md, DECISIONS.md (D-010, D-019, D-022, D-026)
**Tasks:** Set up pnpm workspace, root tsconfig (strict), eslint/prettier, and vitest. Create `services/poster` with `src/api` and `src/worker` entrypoints, plus stubs for `packages/poster-contract`, `packages/poster-client`, `packages/server-core`, and `packages/ui` (design-tokens CSS placeholder). Add dependency-cruiser rules for the D-022 boundaries as `pnpm lint:deps`. Add a Dockerfile for the service. Initialize Supabase locally (`supabase init`, keeping the existing `supabase/migrations/`). The docs are already in `docs/`.
**Acceptance:**
- `pnpm install && pnpm -r build && pnpm -r test && pnpm lint:deps` pass on a clean clone.
- The service starts and serves `GET /healthz` with no `apps/` directory present, both via `pnpm` and via `docker run`.
- `dev:worker` starts, logs, and shuts down cleanly on SIGTERM.
- A deliberate forbidden import (a service importing `packages/ui`) fails `lint:deps`.

### S02: Schema lands + DB invariant tests
**Context:** CLAUDE.md, the 4 `poster` migrations, contract §6 and §9
**Tasks:** Apply the migrations and fix anything that fails, recording the fixes in DECISIONS. Write pgTAP tests. Generate TS types.
**Acceptance (pgTAP):**
- An illegal transition (e.g. `posted→scheduled`) raises.
- A target on another user's connection is rejected by FK. A connection/platform mismatch is rejected.
- `claim_due_targets` called concurrently from two sessions returns disjoint rows.
- `finish_dispatch` with the wrong worker returns false and changes nothing.
- Revoking a connection pauses its scheduled targets and emits `post.paused` and `connection.revoked` events.
- `resume_connection_targets` sends past-grace targets to `failed/token_revoked_expired`.
- A second `unknown` during reconciliation leads to `failed/dispatch_outcome_unknown`.
- `authenticated` cannot select `credentials`, `dispatch_attempts`, or `webhook_events`, and sees only its own posts.

### S03: App auth, ID codec, error envelope
**Context:** contract §2 and §8, CLAUDE.md rules 7–8
**Tasks:** Add `POST /v1/oauth/token` (client credentials → 15-min JWT, argon2id secret check). Add auth middleware with both modes from D-023: app mode (client-credentials JWT) and user mode (Supabase session JWT acting as `poster-web`, where `user_id` must match the token subject). Also add a per-app rate limit (429 + `Retry-After`), the prefixed-ID codec, the error envelope, and a seed script registering `poster-web`, `trainer-dev`, and `test-client`.
**Acceptance:**
- A bad secret returns 401 `invalid_token`, and an expired JWT returns 401.
- A burst over the limit returns 429 with `Retry-After`.
- ID codec round-trip property test passes, and a malformed ID returns a 404 envelope, not a 500.
- A user-mode request for another user's `user_id` returns 403. The same route serves app mode and user mode.
- `packages/poster-contract` holds the auth and error schemas, and `gen` produces an OpenAPI spec and a client that compile.

### S04: Constraint engine as data
**Context:** PRD FR-06, contract §5 and §8, `platform_constraints` table
**Tasks:** Define a spec JSON schema (text length, media count/kinds/formats, video duration, aspect ratios, threads). Seed TikTok and YouTube specs, noting the sources in DECISIONS. Build a pure validator: `(content, overrides, spec) → violations[]`. Add `GET /v1/platforms/constraints`.
**Acceptance:**
- Table-driven unit tests cover every constraint code in contract §8.
- A 2-target request with one bad target yields a 422 with exactly one `details` entry carrying the correct `target_index`.
- No platform limit appears as a literal in TS code (grep check in CI).

### S05: Media + post submission
**Context:** contract §5, FR-05, FR-07, FR-13, FR-14, D-016
**Tasks:** Add `POST /v1/media` (small direct upload + signed-URL flow for large video; probe duration and dimensions with ffprobe). Add `POST /v1/posts` with the idempotency-key flow in one transaction, grant check (403 `grant_missing`), validation, and insertion of posts, post_media, and targets. Add `POST /v1/posts/{id}/cancel`, `PATCH` (re-validates), and `GET /v1/posts/{id}`. Grants for dev come from a seed script (real consent is M2).
**Acceptance:**
- The same key with the same body returns the identical response. The same key with a different body returns 409 `idempotency_conflict`. Parallel identical requests create exactly one post.
- Cancel works in `scheduled`/`paused` and returns 409 `too_late` in `dispatching`.
- Omitted `schedule_at` means `due_at` = now.

### S06: Adapter interface, fake adapter, dispatcher
**Context:** CLAUDE.md rules 2–4 and 10, D-012, `claim_due_targets` / `finish_dispatch`
**Tasks:** Define the adapter interface: `publish(attemptRef, credential, target, renditions) → {success|transient|permanent|unknown}` and `lookup(attemptRef) → {found|absent|unknown}`. Build a fake adapter with scripted outcomes, latency, and hangs. Build one dispatch loop per enabled platform, each with its own concurrency and poll interval: claim, insert the attempt row, decrypt the credential (with an access log entry), publish, then `finish_dispatch`.
**Acceptance:**
- Scripted transient ×2 then success yields `posted` with 3 attempts and backoff respected.
- Permanent yields `failed/platform_rejected` with the platform message.
- A hung TikTok fake does not delay YouTube posts (measured).
- p95 lag under 60 s across 500 posts scheduled for the same minute (local).

### S07: Crash safety & reconciliation
**Context:** D-012, `mark_stale_dispatches`
**Tasks:** Build the reconciler loop: stale leases go to `lookup()`, and the result resolves through `finish_dispatch(p_worker => claimed_by)`. Write a chaos test that SIGKILLs the worker at random points around the adapter call.
**Acceptance:**
- 100 chaos runs produce zero double-posts (the fake adapter counts real publishes per target).
- Every target reaches a terminal state or `scheduled`, and none is stuck in `dispatching` beyond lease plus one reconciler tick.

### S08: Webhook delivery
**Context:** contract §7, D-014, `claim_webhook_events`
**Tasks:** Build the deliverer: public envelope (prefixed ids, `event_id`, `occurred_at`, `external_ref`, `state`, `data`), `X-Poster-Signature` HMAC with the secret from the secrets-manager interface, exponential backoff, and give-up at 24 h. Ship a tiny reference consumer (`tools/webhook-sink`) that verifies signatures, rejects replays older than 5 min, and dedupes on `event_id`.
**Acceptance:**
- A sink returning 500 three times then 200 receives the event once in effect (deduped).
- A tampered body is rejected by the sink.
- Event payloads validate against zod schemas matching contract §7 for all seven event types.

### S09: Aggregator spike → real adapter
**Context:** PRD OQ-1, adapter interface, D-013
**Tasks:** Time-box to one day. Post the same 60 s vertical video to TikTok and YouTube through both Upload-Post and Ayrshare test accounts. Score each on: reliability, whether the response carries a permalink, idempotency/reference support (this decides how good `lookup()` can be), linked-account health API, pricing at 1k and 10k posts/month, and platform coverage for OQ-2. Record the choice in DECISIONS, then implement the winning adapter and replace the seeded constraint specs with its real limits.
**Acceptance:**
- A DECISIONS entry exists with the scorecard.
- A real scheduled post lands on both platforms via the Poster API, with permalinks in `post.posted` webhooks.

### S10: M1 exit
**Context:** the M1 exit criteria above
**Tasks:** Write an end-to-end script (`tools/m1-demo`) that uses only `packages/poster-client` against a running service, as any future app would. It registers an app, uploads video, submits a scheduled post with 2 targets, and asserts webhooks. Add a runbook (env vars, secrets, deploy of api + worker containers per D-018) and a punctuality/double-post dashboard query.
Add the CI contract test (D-026): service responses validate against the generated spec.
**Acceptance:** The M1 exit criteria hold on a deployed staging environment, not just locally, with the demo script talking to the deployed backend and no frontend deployed.
