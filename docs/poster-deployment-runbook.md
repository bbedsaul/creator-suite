# Social Poster — deployment runbook

For operators. Covers what to set, how to deploy the two containers, how to tell
whether it is working, and what to do when it is not.

Scope: the Poster backend only. **No frontend is deployed in M1** (D-022, D-024):
`apps/poster-web` arrives in M3, and the service is a complete product without it.

---

## 1. Shape of the deployment

One image, two long-running containers, one database (D-022, D-034).

| Container | Command | Scales on | Notes |
|---|---|---|---|
| **api** | `node dist/api/index.js` (default `CMD`) | request volume | Stateless. Run 2+ for availability. |
| **worker** | `node dist/worker/index.js` | targets due per minute | Per-platform dispatch loops, reconciler, webhook deliverer. |

```
docker build -f services/poster/Dockerfile -t poster-service .   # context = repo root
docker run -p 8080:8080 poster-service                            # api
docker run poster-service node dist/worker/index.js               # worker
```

The image is Alpine with `ffmpeg` installed from apk, because `/v1/media` shells
out to `ffprobe` and the npm-packaged binaries have no musl build (D-062).

**Multiple workers are safe and expected.** Claiming goes through
`poster.claim_due_targets`, which uses `for update skip locked`, and completion is
fenced on `claimed_by` — so two workers cannot take the same target and a revived
zombie cannot finish one that has been reassigned (D-012). There is no leader
election to configure.

### Host: Fly.io

**Decided** (D-098, confirmed 2026-09-27), superseding D-018's "TBD by S10". Why:

- Long-running processes are the default rather than a workaround; the worker is
  not a request handler and must not be scaled to zero or cycled mid-dispatch.
- Private networking to Supabase without exposing the worker publicly.
- Deploying the same image twice with different commands is a first-class flow,
  which is exactly D-034.

Config lives in `deploy/fly/api.toml` and `deploy/fly/worker.toml`. See §3 for the
deploy commands.

**Two Fly apps, not one app with two process groups** (D-102). Process groups
would be neater, but Fly secrets are per **app**, and these two processes have
disjoint secret needs — `VAULT_MASTER_KEY` belongs only to the worker, and
`APP_TOKEN_SECRET` and `SUPABASE_SERVICE_ROLE_KEY` only to the API. The config
module already enforces that split; collapsing it to save one file would hand the
API the key that wraps every stored credential, for nothing.

Nothing in the application depends on the host, so this stays cheap to reverse.
What *any* host must provide: run a container indefinitely, never scale the worker
to zero, allow ~60 s for graceful shutdown on SIGTERM, and inject secrets as
environment variables.

---

## 2. Environment

Anything marked **required** has no default and the process refuses to start
without it. That is deliberate: a missing secret should be a failed deploy, not a
silent fallback.

### Both containers

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | ✅ | — | Direct Postgres connection as the service role. **Not** PostgREST. |
| `NODE_ENV` | | `development` | `production` in deployment. |
| `LOG_LEVEL` | | `info` | pino level. |
| `SHUTDOWN_TIMEOUT_MS` | | `10000` | Grace period on SIGTERM. |

### api only

| Variable | Required | Default | Notes |
|---|---|---|---|
| `APP_TOKEN_SECRET` | ✅ | — | HS256 signing key for app-mode tokens. **Minimum 32 characters**, enforced at startup. |
| `APP_TOKEN_KEY_ID` | | `k1` | `kid` header, so the key can be rotated (D-046). |
| `APP_TOKEN_ISSUER` | | `poster-api` | Must match the worker's expectation of issued tokens. |
| `APP_TOKEN_AUDIENCE` | | `poster-api` | |
| `SUPABASE_JWKS_URL` | ✅ | — | User-mode verification, e.g. `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`. |
| `SUPABASE_JWT_ISSUER` | ✅ | — | e.g. `https://<ref>.supabase.co/auth/v1`. |
| `SUPABASE_URL` | ✅ | — | Storage API for media. |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | — | Storage only. Never reaches a browser (D-024). |
| `MEDIA_BUCKET` | | `poster-media` | Must exist and be **private**. |
| `MAX_DIRECT_UPLOAD_BYTES` | | `8388608` | Above this, clients must take the signed-URL path (D-061). |
| `SIGNED_UPLOAD_TTL_S` | | `3600` | |
| `FIRST_PARTY_CLIENT_ID` | | `poster-web` | The app user-mode requests act as (D-023). |
| `TOKEN_ENDPOINT_LIMIT_PER_MIN` | | `30` | Per-app limit on `/v1/oauth/token`. |
| `CORS_ALLOWED_ORIGINS` | | *(empty)* | Comma-separated. Empty in M1: there is no browser client yet. |
| `PORT` / `HOST` | | `8080` / `0.0.0.0` | Set by the image. |
| `FFPROBE_PATH` | | `ffprobe` on PATH | Leave unset in the container; apk puts it on PATH. |

### worker only

| Variable | Required | Default | Notes |
|---|---|---|---|
| `VAULT_MASTER_KEY` | ✅ | — | 32 bytes base64 (`openssl rand -base64 32`). Wraps per-credential data keys (D-020, D-071). Length is validated at startup. |
| `DISPATCH_CONCURRENCY` | | `8` | Per platform. |
| `DISPATCH_POLL_INTERVAL_MS` | | `1000` | A full batch re-claims immediately, so this is the idle interval. |
| `DISPATCH_LEASE_MS` | | `300000` | **Must exceed `PUBLISH_TIMEOUT_MS`** — startup refuses otherwise (D-073). |
| `PUBLISH_TIMEOUT_MS` | | `30000` | Hard deadline per adapter call. |
| `DISPATCH_OVERRIDES` | | *(empty)* | JSON keyed by platform id, e.g. `{"tiktok":{"concurrency":2}}`. Throttle one platform without touching another (rule 10). |
| `RECONCILE_BATCH_SIZE` | | `25` | |
| `RECONCILE_POLL_INTERVAL_MS` | | `15000` | Worst-case stuck time is roughly lease + this. |
| `LOOKUP_TIMEOUT_MS` | | `15000` | |
| `WEBHOOK_BATCH_SIZE` | | `25` | |
| `WEBHOOK_POLL_INTERVAL_MS` | | `2000` | |
| `WEBHOOK_LEASE_MS` | | `60000` | |
| `WEBHOOK_TIMEOUT_MS` | | `10000` | Per delivery attempt. |
| `WEBHOOK_GIVE_UP_AFTER_MS` | | `86400000` | 24 h, per contract §7. |
| `WEBHOOK_BASE_BACKOFF_MS` | | `10000` | |
| `WEBHOOK_MAX_BACKOFF_MS` | | `3600000` | |
| `WORKER_POOL_SIZE` | | `max(4, concurrency + 2)` | Postgres connections. |

Plus **one variable per app webhook secret**. `client_apps.webhook_secret_ref`
holds a reference such as `env:ACME_WEBHOOK_SECRET`, never the secret, and the
worker resolves it from its own environment (D-080). Names are restricted to
`[A-Z][A-Z0-9_]*` on purpose: the reference comes from the database, so without
that restriction anyone who could write `webhook_secret_ref` could read
`DATABASE_URL`.

### Secrets

Five things are secrets: `DATABASE_URL`, `APP_TOKEN_SECRET`,
`SUPABASE_SERVICE_ROLE_KEY`, `VAULT_MASTER_KEY`, and each app's webhook secret.
Inject them as environment variables from the host's secret store; never bake them
into the image or commit them. Locally they live in `.env.local`, which is
gitignored.

**`VAULT_MASTER_KEY` is the one that cannot be lost.** Every stored credential is
encrypted under a data key wrapped by it. Lose it and every connection must be
re-authorised by its user; leak it and every stored token is exposed. Keep it in
the host's secret manager with the same care as a database password, and note that
rotating it needs a re-wrap pass that does not exist yet (M2, D-020).

---

## 3. First deploy

1. **Database.** Apply migrations from a checkout, not from a container:
   `supabase db push` against the target project, or `psql -f` each file in
   `supabase/migrations/` in filename order.
2. **Storage.** Create the `poster-media` bucket, private.
3. **Constraint specs.** `pnpm -F @suite/poster-service seed:constraints` with
   `DATABASE_URL` pointing at the target. A platform with no spec is *unlaunched*:
   the API refuses targets it cannot validate, so this is not optional.
   Specs are still `provisional` until S09's live half replaces them.
4. **Client apps.** `pnpm -F @suite/poster-service seed` registers `poster-web`,
   `trainer-dev`, `m1-demo`, and `test-client`. **`test-client` carries a
   published secret (D-049) — delete it in any real environment, or never grant it
   anything.** Secrets are printed once; store them in the consumer's secret
   store, not here.
5. **Webhook endpoints.** For each app that wants events, set `webhook_url` and
   `webhook_secret_ref` together (a check constraint enforces both-or-neither: a
   URL without a secret would mean sending unsigned events), and put the named
   variable in the worker's environment.
6. **Deploy the api**, confirm `GET /healthz`.
7. **Deploy the worker**, confirm the startup lines below.
8. **Smoke test**: `pnpm -F @suite/m1-demo start` against the deployed API. See §6.

Steps 1, 3 and 4 run from a checkout today, which is a known gap — the loaders
should eventually run as a job in the image so a deploy does not depend on
somebody's laptop.

---

## 3a. Fly.io, concretely

One-time setup, per environment (`-staging`, then `-prod`):

```bash
fly apps create poster-api-staging
fly apps create poster-worker-staging
```

Edit `primary_region` in both configs to match the Supabase project's region.
Every dispatch decision is a database round trip, so cross-region latency lands
straight on the NFR-01 lag budget.

### Secrets

Set them per app, and only where they are needed (D-102):

```bash
# API
fly secrets set --app poster-api-staging \
  DATABASE_URL='postgresql://…' \
  APP_TOKEN_SECRET='…' \
  SUPABASE_URL='https://<ref>.supabase.co' \
  SUPABASE_SERVICE_ROLE_KEY='…' \
  SUPABASE_JWKS_URL='https://<ref>.supabase.co/auth/v1/.well-known/jwks.json' \
  SUPABASE_JWT_ISSUER='https://<ref>.supabase.co/auth/v1'

# Worker
fly secrets set --app poster-worker-staging \
  DATABASE_URL='postgresql://…' \
  VAULT_MASTER_KEY="$(openssl rand -base64 32)"

# Plus one per app webhook secret, on the worker only — it is the process that
# resolves `env:NAME` references (D-080).
fly secrets set --app poster-worker-staging ACME_WEBHOOK_SECRET='…'
```

`VAULT_MASTER_KEY` must be generated **once** and kept. Every stored credential is
encrypted under a data key wrapped by it; generating a fresh one on a later deploy
silently breaks every existing connection. There is no re-wrap path yet (M2).

### Deploying

Build once, deploy that image twice, so both processes are provably the same bits:

```bash
# From the REPO ROOT — the Dockerfile needs the root manifests and workspace packages.
fly deploy --config deploy/fly/api.toml --dockerfile services/poster/Dockerfile .

# Take the image reference the API deploy produced…
fly status --app poster-api-staging          # prints the image ref
fly deploy --config deploy/fly/worker.toml --image <that ref>
```

Building the worker separately would also work and is what most examples show, but
it makes "one image, two entrypoints" (D-034) a claim rather than a fact — two
builds of the same commit are not guaranteed identical.

**Order:** worker first, then API, when a change touches dispatch. See §5.

### Scaling

```bash
fly scale count 2 --app poster-api-staging            # availability
fly scale count 3 --app poster-worker-staging         # throughput
```

Multiple workers need no coordination: claiming is `for update skip locked` and
completion is fenced on `claimed_by` (D-012). Scale the worker on *targets due per
minute*, not CPU — it is almost always waiting on the database or a platform.

### What Fly will not tell you

The worker declares no service, so **Fly cannot health-check it**. A wedged worker
stays "healthy" in `fly status`. Liveness comes from two places instead:

- the five startup lines in §4, on `fly logs --app poster-worker-staging`;
- query 5 in `supabase/observability/poster-m1-metrics.sql` — a growing
  reconciliation backlog means dispatch is not progressing.

Alert on the metrics, not on the platform's dot.

---

## 4. Is it working?

### api

```
curl -fsS https://poster.example.com/healthz
{"status":"ok","service":"poster-api","uptime_s":42}
```

`/healthz` is deliberately unauthenticated and does not touch the database, so it
answers "is this process alive", not "is the system healthy". For the latter, use
the queries in `supabase/observability/poster-m1-metrics.sql`.

### worker

Four log lines within a second of start, one per subsystem:

```
poster-worker starting            workerId=…  adapters=["fake"]
dispatch loop started             platformId=tiktok   concurrency=8
dispatch loop started             platformId=youtube  concurrency=8
reconciler started                pollIntervalMs=15000
webhook deliverer started         pollIntervalMs=2000
```

A missing `dispatch loop started` for a platform means that platform is not
enabled or has no constraint spec — `claim_due_targets` joins both and requires
`platforms.enabled` (D-070), so the worker will never pick its targets up.

`adapters=["fake"]` is correct for M1 and **wrong for production**: the fake
adapter posts nowhere. A real aggregator adapter is registered in S09's live half.

### Alerts

Two, from `supabase/observability/poster-m1-metrics.sql`:

1. **Double posts** (query 2) — any row is an incident. Tracked as a count, not a
   rate (§11), because one is already too many.
2. **Webhooks given up** (query 6) — a consumer permanently missed an event.

Watch, don't page: p95 dispatch lag (query 1, budget 60 s, and `posted_early`
should always be 0), `dispatch_outcome_unknown` count (query 4 — should trend to
~0), and the reconciliation backlog (query 5).

---

## 5. Operating

### Deploying a new version

Order matters once, in one direction: **migrations must be backward compatible
with the running version**, because api and worker roll separately and both will
briefly be mixed. Additive changes only in a single deploy; a destructive change
needs two.

Roll the **worker first, then the api** when a change touches dispatch: a worker
running old code against new rows is the riskier half, and it is the half you want
to observe before request traffic depends on it.

### Graceful shutdown

On SIGTERM the worker stops claiming and finishes in-flight dispatches. Give it at
least `SHUTDOWN_TIMEOUT_MS`, plus the publish timeout, before SIGKILL.

A hard kill is *safe but not free*: targets left in `dispatching` are picked up by
`mark_stale_dispatches` once their lease expires and resolved by the reconciler
through `lookup()`. That is proven across 100 real SIGKILLs with zero double posts
(D-076). But recovery takes a lease, so a routine deploy should not rely on it.

### Rollback

The api is stateless — roll back freely. The worker is too, with one caveat: rows
already `dispatching` stay leased until they expire, so a rollback does not
un-claim them. Wait a lease before concluding that the rollback did not help.

### Throttling one platform

`DISPATCH_OVERRIDES={"tiktok":{"concurrency":1,"pollIntervalMs":5000}}` and
restart the worker. Each platform has its own loop, so this cannot slow another
platform down (rule 10, NFR-04).

### Pausing dispatch entirely

Set `poster.platforms.enabled = false`. Claiming stops for that platform
immediately; nothing is lost, and targets resume when it is re-enabled (D-070).
Preferred over stopping the worker, which also stops reconciliation and webhooks.

---

## 6. Smoke test

```
POSTER_BASE_URL=https://poster.example.com \
SEED_SECRET_M1_DEMO=…            \
DEMO_USER_ID=…                   \
DEMO_TIKTOK_CONNECTION=cn_…      \
DEMO_YOUTUBE_CONNECTION=cn_…     \
M1_DEMO_WEBHOOK_SECRET=…         \
pnpm -F @suite/m1-demo start
```

It authenticates, uploads a video, validates, submits a scheduled post to two
platforms, replays the idempotency key, and asserts signed webhooks with
punctuality and no duplicates. Exit code is 0 only if every step passed, so it
works as a pipeline gate.

Two things it needs that are easy to miss:

- **Connection ids must be the `cn_…` form**, not raw uuids. `seed:demo` prints
  both; the API accepts only the prefixed form (rule 7).
- **The sink must be reachable from the worker.** The demo listens locally, so
  against a deployed worker the `webhook_url` has to point somewhere that worker
  can reach — a tunnel, or run the demo somewhere routable. A demo whose webhook
  steps time out against a healthy deployment is usually this.

---

## 7. Known gaps at M1

Stated plainly, because a runbook that implies more than exists is worse than none.

- **No real adapter.** `adapters=["fake"]` posts nowhere. S09's live half fixes
  this and is blocked on aggregator credentials (`docs/S09-acceptance.md`).
- **No Connections API.** Connect, disconnect and health checks are M2. Today a
  connection is created by `seed:demo` or by hand.
- **Constraint specs are `provisional`** — from platform documentation, not from
  the aggregator that will actually post, which is usually stricter.
- **`VAULT_MASTER_KEY` rotation** has no re-wrap path yet (M2).
- **Migrations and seeds run from a checkout**, not from the image.
- **No staging environment exists yet**, which is why S10's acceptance criterion
  is unmet. The host is decided and the configs are written (D-098, D-102), but
  nothing has been deployed: everything here is verified locally and **untested
  against Fly.io**. Expect the first deploy to find something — most likely the
  build context, the Supabase region, or a webhook URL the worker cannot reach.
