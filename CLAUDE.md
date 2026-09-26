# CLAUDE.md — Creator Suite

Read this first every session. Then read the session's entry in `docs/poster-m1-session-plan.md` and the decisions log in `DECISIONS.md`. Do not start work without both.

## What this repo is

A pnpm monorepo for the Creator Suite: three products that share one account, one design system, and one publishing backbone.

- **Social Poster** (`services/poster` + `apps/poster-web`): cross-platform publishing. It is both a standalone product and the internal publishing API for the other two apps. **Built first. Current focus: milestone M1.**
- **Podcast Clipper** (`services/clipper` + `apps/clipper-web`): episodes become clips and posts. **Built second** (D-006); first consumer of the Poster API and first builder of `packages/media-pipeline`.
- **Trainer** (`services/trainer` + `apps/trainer-web`): Zoom recordings, manual authoring, and AI generation become sellable courses. Built third.

Source-of-truth documents live in `docs/`:
- `social-poster-prd.md` (the "what")
- `social-poster-internal-api-contract.md` (the wire contract, v1.1; the API must match it exactly)
- `podcast-clipper-prd.md` (built second), `training-application-prd-v2.md` (built third). Not in scope yet.
- `design/` holds the screen prompts; `archive/` holds superseded docs. Don't implement from `archive/`.

If code and a doc disagree, stop and ask. Don't silently pick one.

## Stack

- TypeScript (strict) on Node 24 (Active LTS, D-037), pnpm workspaces.
- Supabase: Postgres, auth, and storage with RLS. Migrations live in `supabase/migrations/`, using timestamp-prefixed names as the Supabase CLI requires.
- **Backends and frontends are separate projects (D-022).** Each backend under `services/` starts and deploys on its own; each UI under `apps/` talks to it only over HTTP.
- `services/poster` has two entrypoints from one package:
  - `src/api/`: Fastify HTTP server implementing the internal API contract, with two auth modes, app and user (D-023).
  - `src/worker/`: long-running process with per-platform dispatch loops, the webhook deliverer, the reconciler, and sweepers.
- API contract as code: zod schemas in `packages/poster-contract`, which generate the OpenAPI spec, which generates `packages/poster-client` (D-026).
- Frontends: Vite + React SPAs (D-025), using the generated client only.
- DB access: `postgres` (postgres.js) with a direct connection as service role. **Not** PostgREST for server code.
- Validation: zod at every external boundary (HTTP bodies, adapter responses, webhook payloads).
- Background jobs: pg-boss for scheduled and background work (credential health checks, transcodes, sweepers). Dispatch and webhook delivery do **not** go through pg-boss; they claim rows directly (see below).
- Tests: vitest (unit and integration against local Supabase) and pgTAP (`supabase test db`) for database invariants.

## Layout

```
services/poster/        Poster backend: api + worker (M1)       ← runs with no frontend
services/clipper/       Clipper backend (after Poster)          ← Poster API client
services/trainer/       Trainer backend (third)                 ← Poster API client
apps/poster-web/        composer UI (M3), HTTP-only
apps/clipper-web/       apps/trainer-web/   (later)
packages/poster-contract/  zod schemas → OpenAPI spec (source of truth)
packages/poster-client/    generated typed SDK (used by apps and other services)
packages/server-core/   backend-only: auth verification, tenancy, billing primitives
packages/ui/            frontend-only: design tokens, components
packages/media-pipeline/   backend-only (built with the Clipper; extended by the Trainer)
supabase/migrations/    all schemas; Poster lives in the `poster` schema
supabase/tests/         pgTAP tests
docs/                   PRDs, API contract, session plan
DECISIONS.md            judgment calls, append-only
```

## Non-negotiable rules

1. **Invariants live in the database.** State transitions, exactly-once claims, ownership, and "failed requires a reason" are enforced by constraints, triggers, and `security definer` functions. App code calls those functions; it doesn't reimplement them.
2. **Dispatch only through `poster.claim_due_targets` / `poster.finish_dispatch`.** Never update `post_targets.state` directly from app code, except for cancel and accept→scheduled, which go through the API service layer.
3. **Never re-dispatch a row in `dispatching`.** A crashed dispatch goes to reconciliation. An ambiguous outcome fails as `dispatch_outcome_unknown`. A failure is recoverable; a double-post is not.
4. **Insert the `dispatch_attempts` row (outcome `in_flight`) before calling any adapter.**
5. **Tokens and credentials never leave the vault module.** Nothing is logged, returned, or put in an error message. Every decrypt writes `vault_access_log`.
6. **Webhook events are created only by DB triggers** (the outbox), never by app code.
7. **IDs:** UUIDs in the database; prefixed IDs (`po_`, `tg_`, `cn_`, `md_`, `ev_`, `sr_`) only at the API boundary, via one encode/decode module.
8. **Errors:** the single envelope from contract §8 everywhere. Constraint rejections are per-target and machine-readable.
9. **Platform limits are data** (`poster.platform_constraints`), never constants in code.
10. **Adapters are isolated.** One platform's outage, rate limit, or slowness must never delay another platform's loop.
11. **Backend/frontend boundary (D-022).** `apps/*` import only `packages/ui`, `*-contract`, and `*-client`. `services/*` never import `apps/*` or `packages/ui`. Services talk to each other only through the generated clients, never by importing another service's code. `pnpm lint:deps` (dependency-cruiser) enforces this in CI.
12. **No browser-to-database path (D-024).** Frontends use Supabase for sign-in only; all data goes through the service API.
13. **Contract first.** API changes start in `packages/poster-contract`, then regenerate the spec and client. Never hand-edit generated files.

## Session protocol

- Each session has a **context block** (files to load) and **acceptance criteria** in the session plan. Load only what's listed.
- Before ending, confirm every acceptance criterion with evidence: a test name, a command output, or a curl transcript.
- Any judgment call not already covered goes into `DECISIONS.md` as a new numbered entry. Don't edit old entries; supersede them.
- Commit at session end and tag it `poster-m1-sNN` (for example, `poster-m1-s03`).
- If a task would change the API contract, stop and ask. Additive changes are allowed only if they're recorded in DECISIONS.md.

## Project skills

Skills live in `.claude/skills/` and load automatically when relevant:
`run-session` (every session), `db-migration` (any SQL), `contract-change` (any API shape), `platform-adapter` (publishing adapters), `creator-suite-ui` (anything in `apps/` or `packages/ui`), and `media-pipeline` (ingest, transcription, LLM passes, rendering).

## Commands

Node 24 is required (`.nvmrc`); run `nvm use` first. The Supabase CLI is a repo
dev dependency, not a global install (D-031), so it runs through `pnpm exec`.

```
pnpm install
pnpm exec supabase start && pnpm exec supabase db reset   # applies all migrations
pnpm exec supabase test db                 # pgTAP
pnpm -F @suite/poster-service test
pnpm -F @suite/poster-service test:integration   # needs a running local stack (D-040)
pnpm -F @suite/poster-service gen:types          # regenerate DB types after a migration
pnpm -F @suite/poster-service seed               # register dev client apps -> .env.local (D-049)
pnpm -F @suite/poster-service seed -- --rotate   # issue new secrets (default preserves, D-051)
pnpm gen:check                                   # committed spec + client match the schemas
pnpm gen:types:check                             # committed DB types match the migrations
pnpm -F @suite/poster-service seed:constraints   # load platform specs -> DB, enables them (D-058)
pnpm -F @suite/poster-service seed:grants -- --user <uuid> [--app trainer-dev]   # dev grants (D-067)
pnpm lint:limits                                 # no platform limit hard-coded in TS (rule 9)
pnpm lint:limits:verify                          # proves lint:limits rejects real violations
pnpm -F @suite/poster-service dev:api      # backend alone — no frontend needed
pnpm -F @suite/poster-service dev:worker
pnpm -F @suite/poster-contract gen         # regenerate OpenAPI spec + client
pnpm lint:deps                             # boundary check (D-022)
pnpm lint:deps:verify                      # proves lint:deps rejects real violations
pnpm -r build && pnpm -r typecheck         # build first: @suite/* resolve via dist
pnpm -r test                               # repo-wide gates
pnpm lint && pnpm format:check             # eslint, prettier
```

CI (`.github/workflows/ci.yml`, D-053) runs all of the above on every push to
`main` and every pull request, in two jobs: `check` needs nothing running, and
`database` starts Supabase with only db, auth and kong.

Container images (one image, two entrypoints — D-034). Build context is the repo
root, not the service directory:

```
docker build -f services/poster/Dockerfile -t poster-service .
docker run -p 8080:8080 poster-service                      # API (default CMD)
docker run poster-service node dist/worker/index.js         # worker
```
