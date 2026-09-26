# Social Poster — PRD

*Creator Suite · Rebuilt from the project chat "Podcast to social media snippets workflow." The original formatted PDF is still downloadable in that chat. Section 4 (Users) was not recovered; see the original. Sections 10 and 11 were rewritten 2026-09-26 (see docs/poster-m1-session-plan.md). §9 updated for the backend/frontend split (DECISIONS D-022).*

## 1. Summary

Social Poster is a cross-platform publishing service with two faces. As a **standalone product**, it lets a creator or small business connect their social accounts once, then compose, schedule, and publish text, image, and video posts across platforms from a single queue. As an **internal API**, it is the publishing backbone of the Creator Suite: the Podcast Clipper and Training Application dispatch their generated content through it exactly as external API customers would.

It owns the hardest shared infrastructure in the suite — the OAuth token vault, refresh lifecycles, platform adapters, per-platform constraints, and reliable scheduled execution — so that work is done once and monetized in every product. It is built first in the suite sequence for exactly that reason.

## 2. Problem

Publishing the same content to five platforms means five upload flows, five character/media constraint sets, five token expiry headaches, and no unified record of what went out. For the suite itself, every content-generating app would otherwise rebuild platform integrations — the slowest, most approval-gated part of any social product — from scratch.

## 3. Goals and Non-Goals

### Goals
- One connection per platform per user, stored in a secure token vault with automatic refresh and clear reconnect flows on revocation.
- Compose once, publish many: per-platform tailoring (caption variants, media transcodes) from a single logical post.
- Reliable scheduling: a post scheduled for 9:00 goes out at 9:00, survives worker restarts, and never double-posts.
- First-class internal API: suite apps are ordinary API clients with callbacks for post lifecycle events.
- Full audit trail: every post's target, content, dispatch time, platform response, and permalink recorded.
- Fast time-to-market by wrapping an aggregator API initially, behind an adapter boundary that allows per-platform direct integrations later without breaking clients.

### Non-Goals (v1)
- Social inbox, listening, comment/DM management.
- AI content generation — sibling apps generate; the Poster publishes. (A lightweight caption-assist may come later.)
- Deep analytics dashboards; v1 records post status and permalinks, engagement metrics are a later phase.
- Team roles/approval workflows within a workspace.

## 5. Product Description

### 5.1 Connections & Token Vault

Connections belong to the *user*, not to any app — one TikTok connection serves the Clipper, Trainer, and the composer simultaneously. Tokens never leave the vault layer; encryption keys live in a KMS, and suite apps receive scopes via a consent flow — never tokens.

### 5.2 Posts & Composition

- Platform constraint engine validates before accept: character limits, media formats/durations/aspect ratios, thread rules — rejections are explicit and machine-readable for API clients.
- Media handling: upload once to object storage; per-platform transcodes produced as needed and cached.
- Composer UI (standalone product): multi-account picker, per-platform preview, schedule picker, queue view.

### 5.3 Scheduling and Dispatch

- Durable schedule queue: posts persist with target time; dispatch workers claim due posts with locking so restarts or concurrent workers cannot double-post.
- Dispatch goes through a **platform adapter interface**; the v1 implementation wraps an aggregator API (Upload-Post or Ayrshare), with direct adapters swappable per platform later.
- Retry policy per failure class (transient vs. permanent); permanent failures surface with the platform's reason.
- Lifecycle events (accepted, scheduled, dispatched, posted with permalink, failed) emitted as webhooks to API clients and shown in the queue UI.

### 5.4 Internal API

- Authenticated service-to-service API: submit post (accounts, content, schedule), cancel before dispatch, query status, list a user's connections and grant state.
- Scope-request flow: a suite app asks for platform scopes; the user approves in a Poster-owned consent screen; the app never sees tokens.
- Idempotency keys on submission so client retries cannot create duplicate posts.

## 6. Key User Flows

- **Connect:** user picks a platform → OAuth → vault stores tokens → connection available to every suite app the user authorizes.
- **Compose & schedule (standalone):** write post → pick accounts → per-platform preview/tailor → schedule → queue → posted with permalinks in history.
- **API dispatch (suite):** Clipper submits 5 clips with staggered times → Poster validates constraints → dispatches on schedule → callbacks update the Clipper's review board statuses.
- **Token failure:** refresh fails or platform revokes → affected scheduled posts pause → user notified across apps → reconnect → paused posts resume.

## 7. Functional Requirements

### Connections & Vault
- **FR-01** — OAuth connect/disconnect flows for each launch platform; connection state (active, expiring, revoked) queryable per user.
- **FR-02** — Tokens encrypted at rest; access only via the vault service layer; no token ever returned by any API.
- **FR-03** — Automatic refresh ahead of expiry; failed refresh moves the connection to revoked state, pauses dependent scheduled posts, and notifies the user.
- **FR-04** — Scope-request and consent flow for suite apps against a user's existing connections.

### Posts & Validation
- **FR-05** — Logical posts with per-platform overrides; text, single image, multi-image, and video content types at launch.
- **FR-06** — Constraint validation at submission (length, media specs, thread rules) with machine-readable rejection reasons.
- **FR-07** — Media uploaded once; per-platform transcodes generated on demand and cached.
- **FR-08** — Thread support on platforms that have it (ordered multi-part posts).

### Scheduling & Dispatch
- **FR-09** — Durable scheduling with worker claiming/locking; exactly-once dispatch per post per account under restarts and concurrency.
- **FR-10** — Platform adapter interface; v1 aggregator-backed implementation; per-platform direct adapters can replace it without client-visible changes.
- **FR-11** — Classified retries: transient failures retry with backoff; permanent failures finalize with the platform reason.
- **FR-12** — Lifecycle webhooks to API clients and a queue/history UI for direct users, including posted permalinks.
- **FR-13** — Cancel/edit before dispatch; edits re-validate constraints.

### API, Billing & Admin
- **FR-14** — Service-to-service API with per-app credentials and idempotency keys on post submission.
- **FR-15** — Standalone subscription billing (Stripe) by connected account count and monthly post volume; suite apps' usage attributed for internal cost accounting.
- **FR-16** — Admin views: dispatch success rates per platform, token failure rates, aggregator cost per post, abuse flags and per-user posting suspension.

## 8. Non-Functional Requirements

- **NFR-01** — Dispatch punctuality: 95% of posts dispatched within 60 seconds of scheduled time; none early.
- **NFR-02** — Zero double-posts: dispatch idempotency enforced at the database claim, not in worker memory.
- **NFR-03** — Vault security: tokens encrypted with keys outside the application database; access audited.
- **NFR-04** — Adapter isolation: one platform's outage or rate limit cannot delay dispatch to other platforms.
- **NFR-05** — Every post's full content and platform response retained for audit; retention policy per plan.
- **NFR-06** — RLS per-user isolation on all tables; suite apps act only within scopes the user granted.

## 9. System Architecture

- **services/poster** — this product's backend, runnable and deployable on its own: internal API, vault service, constraint engine, dispatch workers, adapter layer.
- **apps/poster-web** — composer UI; talks to services/poster only over HTTP (user-mode auth).
- **packages/poster-contract / poster-client** — API schemas → OpenAPI → generated SDK used by every consumer.
- **packages/server-core / ui** — backend-only shared code (auth, tenancy, billing) and frontend-only shared code (design tokens, components).
- **Consumers** — services/clipper and services/trainer via the internal API in app mode; direct users via poster-web.

Platform services: Supabase (Postgres, auth, storage, RLS), Stripe (subscriptions), pg-boss for background jobs with row-level claims for dispatch (D-011), object storage with signed URLs for media, aggregator API (Upload-Post/Ayrshare) behind the adapter interface. Token encryption keys held in a KMS/secrets manager, not the database.

## 10. Milestones

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M1: Publish Core** | Schema, internal API (auth, media, posts, cancel/patch, constraints), constraint engine, adapter interface + fake + one aggregator adapter, per-platform dispatcher, reconciliation, webhook outbox | An API client submits a scheduled video post to TikTok and YouTube. It posts within 60 s of `schedule_at`, and signed webhooks arrive. Killing the worker mid-dispatch produces zero double-posts across 100 chaos runs. |
| **M2: Connections & Consent** | Connect/disconnect via the aggregator, health checks, revoke → pause → reconnect → resume, scope-request consent screen, grants, remaining launch platforms | A revoked connection pauses its queue. Reconnecting inside the grace window resumes it, and outside the window it fails with `token_revoked_expired`. A second app sees only the scopes it was granted. |
| **M3: Composer** | `apps/poster-web` SPA (onboarding, composer, queue/history, connections screen) on the Creator Suite design tokens, using only `poster-client` and user-mode auth | A new user connects an account and schedules a first post in under 2 minutes. |
| **M4: Self-Serve & Ops** | Stripe billing (accounts + post volume), usage attribution for suite apps, admin views, suspension, retention | A stranger signs up, pays, and has posts go out with zero operator involvement. Admin can suspend a user and see per-platform success rates. |

Build order is Poster → Clipper → Trainer (D-006). Clipper M2 (Review & Publish) depends on Poster M1 and M2; the Trainer's promotion milestone (Trainer M4) comes after that.

## 11. Success Metrics

- **Punctuality:** p95 dispatch lag under 60 s, and none early (NFR-01).
- **Double-posts:** 0, tracked as an alert rather than a rate (NFR-02).
- **Dispatch success rate** per platform, and **`dispatch_outcome_unknown` count** (should trend to ~0).
- **Connection health:** revocations per 100 connections per month, and the reconnect rate within the grace window.
- **Aggregator cost per posted target.**
- **Activation:** % of signups with one connected account and one scheduled post in their first session.
- **Trial-to-paid conversion; suite-app share of post volume.**

## 12. Open Questions

- **OQ-1** — Aggregator selection (Upload-Post / Ayrshare / Blotato) — gates M1 and constrains which platforms can launch.
- **OQ-2** — Launch platform order (drives OAuth work and aggregator choice); shortlist X, LinkedIn, Instagram, TikTok, YouTube, Facebook Pages.
- **OQ-3** — Billing boundary: does suite-app usage count against a user's Poster plan, or is it bundled into each app's subscription? (Pairs with Clipper OQ-5.)
- **OQ-4** — Best-time-to-post suggestions in v1 or later?
- **OQ-5** — When engagement analytics arrive, do they live here (per post) or in a suite-level analytics surface?
