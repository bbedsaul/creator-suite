# DECISIONS.md — Creator Suite

Append-only. To change a decision, add a new entry that supersedes the old one.
Status: **Decided** (Bill confirmed) · **Proposed** (made during bootstrap; confirm or overturn before the session that depends on it).

---

## Product (carried from planning)

**D-001 · Decided · 2026-09** — Social Poster ships both as a standalone product and as the internal publishing API. Suite apps are ordinary API clients with no privileged path.

**D-002 · Superseded by D-006 · 2026-09** — Build order: Poster, then Trainer, then Clipper. The Poster is built first because it owns the hardest shared infrastructure.

**D-003 · Decided · 2026-09** — The suite-wide design system is the one extracted from the Poster composer design (Sora display, Instrument Sans, teal accent, warm neutrals). Every Poster, Trainer, and Clipper screen uses it.

**D-004 · Decided · 2026-09** — Trainer selling is creator-led (public sales pages plus promo clips via the Poster), not marketplace-led.

**D-005 · Decided · 2026-09-22** — Trainer v2 content model is Course → Module → Chapter → Item, with typed items and quizzes. Every course is sellable regardless of origin, and quality gates for generated courses are deferred. Trainer PRD v2 and the v2 migrations supersede v1.

**D-006 · Decided · 2026-09-26 · supersedes D-002** — Build order: Poster, then **Clipper**, then Trainer. The Clipper becomes the first consumer of the Poster API and the first builder of `packages/media-pipeline` (ingest, Whisper, structured-output LLM step, FFmpeg render dispatch). *Implications:* the pipeline is shaped by clip-length CPU renders first, so the Trainer later adds Zoom ingest and the GPU render pool as extensions rather than as the baseline. Poster M2 (connections & consent) must land before Clipper M2 (Review & Publish). The Trainer's v2 migrations sort after both the Poster and Clipper sets (see D-021).

## Architecture (bootstrap, 2026-09-26)

**D-010 · Decided · 2026-09-26** — All Poster tables live in the Postgres schema `poster`, isolated from the Trainer and Clipper schemas in the same Supabase project.

**D-011 · Decided · 2026-09-26** — Use pg-boss, not BullMQ, for background jobs. We're already on Postgres, so this adds no Redis. *Refinement:* dispatch and webhook delivery don't go through pg-boss. They claim rows directly with `FOR UPDATE SKIP LOCKED` (`claim_due_targets`, `claim_webhook_events`), because NFR-02 requires the claim to be the row itself.

**D-012 · Decided · 2026-09-26** — Exactly-once means "never re-dispatch in-flight work." Only `scheduled` rows are claimable. A worker that dies mid-call leaves the target in `dispatching`. After its lease expires, the row is flagged `needs_reconciliation`, and the reconciler asks the adapter whether the attempt landed. If it still can't tell, the target fails with `dispatch_outcome_unknown`. The attempt id is passed to the aggregator as its idempotency/reference key where supported.

**D-013 · Decided · 2026-09-26** — In v1, the aggregator holds the platform OAuth tokens. Our vault stores the user's aggregator profile key (`credential_kind = aggregator_profile`), and `connections` mirrors the aggregator's linked accounts. Direct adapters later store per-connection `oauth_token` credentials in the same table, so no migration is needed. *Implication:* in v1, "refresh" means a health check against the aggregator, not a token refresh.

**D-014 · Decided · 2026-09-26** — Webhook events use a transactional outbox written by triggers on state changes. The delivery worker builds the public envelope (prefixed ids, HMAC signature) and retries with backoff for 24 hours.

**D-015 · Decided · 2026-09-26 · contract-additive** — Add `reason_class` values `grant_revoked`, `rendition_failed`, and `dispatch_outcome_unknown`, plus the transitions `accepted→failed`, `scheduled→failed`, and `paused→canceled`. All are additive under contract §10. Update the contract doc to match.

**D-016 · Decided · 2026-09-26** — `accepted` means "waiting for per-platform media renditions." Targets needing no transcode are inserted directly as `scheduled`.

**D-017 · Superseded by D-023** — The standalone composer (`poster-web`) is a first-party client app that calls the same internal API. It has one code path, and the composer gets the idempotency, validation, and webhooks for free.

**D-018 · Superseded by D-022** — `apps/poster` is one package with two entrypoints (`api`, `worker`), deployed as two containers. Supabase can't host long-running workers. The container host is TBD (Fly.io or Railway); decide by S10.

**D-019 · Decided · 2026-09-26** — API framework: Fastify plus zod. DB client: postgres.js with a direct service-role connection.

**D-020 · Decided · 2026-09-26** — Credentials use envelope encryption: a per-row data key, wrapped by the KMS. Local dev uses an env-held key behind the same interface. The production KMS (AWS or GCP) is TBD by M2.

**D-021 · Decided · 2026-09-26** — Migrations use Supabase CLI timestamp naming. The Trainer v2 migration set, previously numbered `001–004`, must be renamed to timestamps that sort *after* the Poster and Clipper sets before it lands in the repo.

## Backend / frontend separation (2026-09-26)

**D-022 · Decided · supersedes D-018** — Every product's backend is a separate, independently runnable and deployable service, and every UI is a separate app that talks to it only over HTTP. Layout:

```
services/poster/        Fastify API + worker (two entrypoints, two containers)
services/clipper/       (later) — calls the Poster API as a client
services/trainer/       (later) — calls the Poster API as a client
apps/poster-web/        UI only
apps/clipper-web/       UI only
apps/trainer-web/       UI only
packages/poster-contract/  zod schemas + generated OpenAPI spec (source of truth)
packages/poster-client/    typed SDK generated from the OpenAPI spec
packages/server-core/   backend-only shared code (auth verification, tenancy, billing)
packages/ui/            frontend-only shared code (design tokens, components)
packages/media-pipeline/   backend-only
```

Rules: a backend starts, runs, and passes its tests with no frontend present. Frontends import only `packages/ui`, `*-contract`, and `*-client`, never `services/*` or `server-core`. Services never import `apps/*` or `packages/ui`. This is enforced in CI with dependency-cruiser. The PRDs' §9 `apps/<name>` paths are superseded by this layout. *Why:* future apps, internal or third-party, depend on the published API and SDK, not on code.

**D-023 · Decided · supersedes D-017** — The Poster exposes one `/v1` API with two auth modes. **App mode:** client-credentials JWT, with the user passed as `user_id` (the contract as written, for services such as Clipper and Trainer). **User mode:** the user's Supabase session JWT from a browser. It acts as the first-party `poster-web` app, and `user_id` must equal the token subject. There's one set of routes and handlers, so the composer can never drift from what external clients get. *Why the change:* a browser can't hold a client secret, so D-017's "composer is an ordinary client-credentials app" doesn't work as written.

**D-024 · Decided · 2026-09-26** — Frontends read and write only through their service's API. There are no direct Supabase table queries from browsers; Supabase is used client-side for sign-in only. The RLS read policies from migration 4 stay as defense in depth. Live queue updates come from the API over SSE, not Supabase Realtime.

**D-025 · Decided · 2026-09-26** — App UIs are Vite + React SPAs served as static files, with the API base URL set by env and CORS allow-listed per origin in the service. The Trainer's public sales pages need SEO and may need SSR; decide that when the Trainer starts.

**D-026 · Decided · 2026-09-26** — The OpenAPI spec is generated from the zod schemas in `packages/poster-contract`, and `packages/poster-client` is generated from the spec. A contract test in CI fails if the running service's responses don't validate against the spec. The same pattern applies to `clipper-contract` and `trainer-contract` if those services expose APIs to other apps.

**D-027 · Decided · 2026-09-26** — API contract v1.1 published in `docs/`, applying D-012, D-015, D-016, and D-023. The repo copy is now the implementation source of truth; the older live doc in the Claude project is a historical reference until it's re-synced.

**D-028 · Note · 2026-09-26** — The Trainer v2 migration set isn't in this repo yet (it was never exported from the planning chat). Bring it in when the Trainer starts, renamed per D-021.

**D-029 · Decided · 2026-09-26** — Six project skills live in `.claude/skills/`, versioned with the code: run-session, db-migration, contract-change, platform-adapter, creator-suite-ui, and media-pipeline. Changes to a skill follow the same commit rules as code.

## Open (from PRDs, not blocking M1)

- **Trainer sales pages rendering (SPA vs SSR):** decide at Trainer start (D-025).
- **OQ-1 aggregator:** decided in S09 by spike (Upload-Post vs Ayrshare).
- **OQ-2 launch platforms:** M1 targets TikTok and YouTube. The rest come with M2.
- **OQ-3 billing boundary:** before M4 pricing pages.
- **Grace window:** 60 minutes, the default in `resume_connection_targets` / `expire_paused_targets`. Validate in M2.
- **Large-video upload path:** signed URL, decided in S05.

## Monorepo bootstrap (S01, 2026-09-26)

**D-030 · Note · 2026-09-26** — S01 was executed while D-010, D-019, D-022, and D-026 were still marked **Proposed**. Bill was told and chose to proceed. The workspace layout, Fastify choice, and contract-first pipeline are now built on them, so overturning any of those becomes a refactor rather than an edit. They stay **Proposed** until explicitly confirmed.

**D-031 · Decided · 2026-09-26** — The Supabase CLI is a repo `devDependency` (`supabase` on the root package), run as `pnpm exec supabase …`, not a global install. *Why:* the CLI version determines migration and `supabase test db` behavior, so it belongs in the lockfile with everything else that decides whether a build reproduces. CLAUDE.md's Commands section was updated accordingly.

**D-032 · Decided · 2026-09-26** — Packages are ESM (`"type": "module"`) on `module`/`moduleResolution: NodeNext`, compiled by `tsc` to `dist/`, and `pnpm -r build` relies on pnpm's topological ordering rather than TS project references. Each shared package additionally declares a `source` export condition pointing at `src/index.ts`. *Why the `source` condition:* without it, `@suite/x` resolves to `dist/index.d.ts`, which meant dependency-cruiser saw no cross-package edges at all and `lint:deps` passed on imports it was supposed to reject. Node, tsc, and Vite all ignore the unknown condition, so it is inert outside path-aware tooling, and `lint:deps` now works on an unbuilt tree.

**D-033 · Decided · 2026-09-26** — The D-022 boundaries are enforced by path-based dependency-cruiser rules (`.dependency-cruiser.cjs`), not package-name rules, because pnpm symlinks resolve to real workspace paths — so one rule catches `@suite/ui`, `../../packages/ui/...`, and `dist` re-exports alike. `pnpm lint:deps:verify` plants three real violations (service → ui by package name, service → ui by relative path, app → service), asserts the named rule rejects each, and cleans up. *Why:* a green boundary check is meaningless unless something proves it can go red; this is the second bug of that exact kind found in one session.

**D-034 · Decided · 2026-09-26** — One container image per service with two entrypoints: the API is the default `CMD`, the worker overrides it with `node dist/worker/index.js` (the deployment shape D-022 calls for). The image builds from the **repo root** as context, installs with `--filter '@suite/poster-service...'`, and ships only `dist` plus production dependencies via `pnpm deploy --prod --legacy`; it runs as the non-root `node` user with a `HEALTHCHECK` against `/healthz`. Only the service and the backend packages it depends on are copied in, so frontend code cannot reach the image even by accident. *Related:* the `dev:api`/`dev:worker` scripts `exec` into `tsx` so a SIGTERM reaches the worker instead of orphaning it — without `exec`, pnpm died and left the worker running.

**D-035 · Decided · 2026-09-26** — Operational endpoints live outside `/v1` and outside the versioned API contract; `/healthz` is the first. It is **liveness only** and deliberately does not check Postgres or the aggregator, so a dependency outage cannot make the platform kill healthy containers. Readiness, if it is ever needed, is a separate endpoint. *Why this is recorded:* it means adding `/healthz` was not a contract change and needed no `packages/poster-contract` update, which is otherwise required for anything the API serves (CLAUDE.md rule 13).

**D-036 · Decided · 2026-09-26** — Prettier formats code but not Markdown: `*.md` and `docs/` are in `.prettierignore`. *Why:* the PRDs, the API contract, DECISIONS, and the session plan are authored source-of-truth prose. A formatter reflowed all seven of them on its first run, which is pure diff noise in exactly the files where a diff is supposed to mean something.

**D-037 · Decided · 2026-09-26 · supersedes the Node 22 baseline in CLAUDE.md** — The runtime is **Node 24 "Krypton" (24.21.0)**, the Active LTS, on `node:24-alpine` images, with `@types/node@^24` and a TS target of ES2024. *Why:* Node 22 entered Maintenance LTS on 2025-10-21 — security fixes only — so the repo was pinned on day one to a line that had been in maintenance for eleven months. Node 24 is supported to 2028-04-30, past M4. *Why not Node 26,* which becomes the Active LTS on 2026-10-28: it is Current today, and S03 (argon2id), S09, and the Clipper's `media-pipeline` bring native and NAPI-prebuilt modules whose prebuilds lag the Current line (ABI 147 vs 137). *Known limit:* Node 24 itself enters Maintenance LTS on 2026-10-20, so this is a well-supported baseline, not a permanent one. Revisit the 24 → 26 bump in early 2027, once 26 has settled as LTS; doing it before M4 keeps it a manifest-only change.

## Schema and DB invariant tests (S02, 2026-09-26)

**D-038 · Decided · 2026-09-26** — The four bootstrap migrations applied cleanly from zero on Postgres 17 and needed **no fixes**. Every invariant they claim was then exercised against a live database, including the paths a migration alone never runs: the insert-time event trigger, the guard trigger's claim-clearing, and `finish_dispatch`'s branches. They are now tagged, so per the `db-migration` skill they must never be edited in place — changes ship as new timestamped migrations.

**D-039 · Decided · 2026-09-26** — pgTAP is created **inside each test file's transaction** and rolled back with it, never added to a migration. Shared fixtures live in `supabase/tests/_fixtures/*.psql`, included with `\ir`. *Why both of these are odd-looking:* `supabase test db` mounts only `supabase/tests/` into the runner container, so a fixture cannot live outside it, and the runner executes **every `*.sql`** under that directory as a test file — a fixture named `.sql` is run with no transaction of its own and COMMITS its rows into the database. That actually happened during this session and had to be cleared with `db reset`. The `.psql` extension keeps fixtures out of that glob; do not rename them.

**D-040 · Decided · 2026-09-26** — The "concurrent claims return disjoint rows" invariant is proven by a **vitest integration test with two real connections** (`services/poster/test/integration/claim-concurrency.test.ts`), not by pgTAP. *Why:* `for update skip locked` only means anything when a second session contends while the first holds rows locked and uncommitted, and a pgTAP file is one session inside one rolled-back transaction. dblink would supply the second session, but Supabase's local `pg_hba` trusts `127.0.0.1`, so no password is exchanged and dblink refuses to connect as a non-superuser. The test drains all due work as worker A rather than claiming a fixed count, so a stray row left by another run cannot make it pass for the wrong reason. Integration tests are **excluded from `pnpm -r test`** (`vitest.config.ts`) and run via `pnpm -F @suite/poster-service test:integration`, so the repo-wide gate still passes on a clean clone with nothing running. This is also why `postgres` (postgres.js, D-019) is now a service dependency.

**D-041 · Decided · 2026-09-26** — Database types are generated to `services/poster/src/db/database.types.ts` for the `poster` schema only, by `pnpm -F @suite/poster-service gen:types`. The script formats the output with the repo's Prettier config, because the Supabase CLI emits unformatted TypeScript that would fail `pnpm format:check` on every regeneration. `test/database-types.test.ts` asserts the generated enums against contract §6 and §8 plus the D-015 additions, so a migration that lands without a regeneration fails a test instead of producing a wrong type several sessions later. These types describe direct service_role access through postgres.js; they are not a PostgREST surface and no browser sees them (D-024).

**D-042 · Note · 2026-09-26** — Bill confirmed every entry that was still marked **Proposed** (D-010 through D-036), so the file now carries no Proposed decisions. This closes the caveat in D-030: the architecture S01 and S02 were built on is settled, not provisional. D-028 and D-030 stay **Note**s because they record facts rather than choices. Entries that still contain a deferred sub-question — the production KMS in D-020, Trainer sales-page rendering in D-025, the aggregator in the open items list — remain deferred on that specific point; confirming the entry did not decide the part it explicitly left open.

## App auth, ID codec, error envelope (S03, 2026-09-26)

**D-043 · Decided · 2026-09-26** — Public IDs are `<prefix>_<26 chars>`, where the body is **Crockford base32** of the resource's UUID. The codec lives in `packages/poster-contract`, not in the service, because the format is part of the published API. *Why Crockford over base58, base64url or hex:* it is case-insensitive and excludes I, L, O and U, so an ID survives being read over the phone, retyped from a support ticket, or double-clicked in a terminal. base64url's `-` and `_` break double-click selection and it is case-sensitive; hex is 32 characters for no benefit. These IDs land in client databases and webhook payloads forever, so the format is effectively permanent. A malformed ID decodes to `undefined` rather than throwing, so a handler turns it into `404 not_found` and never a 500.

**D-044 · Decided · 2026-09-26 · contract-additive** — Every error envelope carries `request_id`, echoed in the `X-Request-Id` response header; an inbound `X-Request-Id` is adopted so a caller's correlation id survives into our logs. Contract doc bumped to v1.2. *Why:* "quote the request id" is only a complete instruction if the id is in the body the client already logged, not solely in a header a client library may discard.

**D-045 · Decided · 2026-09-26** — Client secrets are hashed with **argon2id at the OWASP baseline** (m=19456 KiB, t=2, p=1) via `@node-rs/argon2`. *Why that library:* it ships a prebuilt `linux-x64-musl` binary, so the `node:24-alpine` runtime image needs no compiler toolchain; the node-gyp `argon2` package would have forced build tools into the image or a move off Alpine. The variant is the library default rather than an explicit `Algorithm.Argon2id`, because that enum is an ambient const enum and unusable under `verbatimModuleSyntax` — a test pins the produced hash to `$argon2id$` so a library change cannot silently weaken every secret. `needsRehash` plus transparent re-hash on successful authentication means the cost can be raised later without invalidating credentials.

**D-046 · Decided · 2026-09-26** — Two different token verifications, deliberately: **app tokens** are ours, signed HS256 with a secret from the secrets manager and always carrying a `kid` so the key can rotate without a format change; **user tokens** are Supabase's, verified against the project's **JWKS** (asymmetric ES256). *Why asymmetric for Supabase:* the service then never holds Supabase's signing secret, and keys rotate without a redeploy. Verified against the real local stack, which issues ES256 with a `kid` and serves `/auth/v1/.well-known/jwks.json`. `APP_TOKEN_SECRET` is explicitly **not** the Supabase JWT secret. A token is routed to a verifier by its unverified `iss` claim, which is safe because each verifier pins its own expected issuer — a forged `iss` only picks the verifier that will reject it.

**D-047 · Decided · 2026-09-26** — Rate limiting is a `RateLimiter` interface with an in-process token-bucket implementation. Authenticated routes are limited per app using the app's own `rate_limit_per_min` column (our limits are data, like platform limits); the token endpoint is limited per `client_id` + client IP, because it is the only unauthenticated route and therefore the brute-force surface for a `client_secret`. *Known limit:* with N API containers the effective limit is N x the configured value. Acceptable while M1 runs one instance; a Postgres-backed implementation drops in behind the interface when horizontal scaling is real. D-011 rules out Redis.

**D-048 · Decided · 2026-09-26 · contract-additive** — Added `GET /v1/auth/context`, returning the acting app and user with an identical shape in both auth modes. *Why it exists:* the auth layer's entire promise is that both modes behave identically, and without this a client could not ask "which app am I, and which user am I acting for?" without attempting real work. *Why it was added in S03 rather than deferred:* the session's acceptance criteria require proving that one route serves both modes and that a cross-user request is rejected, and S03 otherwise introduces no user-scoped route — the alternative was proving a headline invariant only against a route invented inside a test file.

**D-049 · Decided · 2026-09-26** — The seed script registers `poster-web`, `trainer-dev` and `test-client` with generated 32-byte secrets, written to a gitignored `.env.local` and printed once; re-running rotates rather than duplicating. `test-client` is the exception and carries a fixed, published secret so integration tests do not depend on generated state — safe precisely because it is published, and it must never be granted anything in a real environment.

**D-050 · Decided · 2026-09-26** — `@suite/poster-client` is a **devDependency** of `services/poster`, used only by tests that exercise the service through its own published SDK (and, from S10, the CI contract test). The existing `no-dev-dep-in-src` dependency-cruiser rule keeps production service code from importing it, so the D-022 boundary is enforced rather than merely intended.
