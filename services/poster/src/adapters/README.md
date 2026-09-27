# Platform adapters

| Adapter | id | Idempotency key | Lookup by our reference | Verified platforms |
|---|---|---|---|---|
| Fake | `fake` | yes | yes | all (test only) |
| Chaos | `chaos` | yes | yes | test only |
| Upload-Post | `upload_post` | `Idempotency-Key` header + `external_id` | **yes** — exact filter | none yet |
| Ayrshare | `ayrshare` | `idempotencyKey` body field | **no** | none yet |

Both aggregator adapters declare `platforms: []` until a live post proves a
platform works (D-083). They are therefore written, tested, and inert: importing
one cannot take TikTok away from the fake. The live half of S09 passes the
verified list in explicitly.

## The one thing to understand

`supportsIdempotencyKey` and `supportsReferenceLookup` are different questions,
and the providers differ on the second one.

Upload-Post accepts `external_id` on the upload **and** lets us filter history by
it. So when a publish ends ambiguously, `lookup` asks "did attempt X post?" and
gets `found` or `absent`. `absent` is what makes a retry safe (D-074), so an
ambiguous dispatch recovers by itself.

Ayrshare accepts `idempotencyKey`, which stops a replay, but publishes no way to
read a post back by it — `GET /post/{id}` wants Ayrshare's own post id, which is
exactly what we do not have when a publish times out. So this adapter's `lookup`
can *recognise* a post by matching the caption in recent history, and can never
*prove* absence. It returns `found` or `unknown`, never `absent`, and a test
asserts that over every recorded history shape. The operational consequence: an
ambiguous Ayrshare dispatch ends as `failed/dispatch_outcome_unknown` and needs a
human.

## Classification

Both adapters route every request through `http.ts`, which answers one question
the outcome then depends on: **did the request reach the provider?**

| Transport result | Outcome | Why |
|---|---|---|
| `not_sent` (DNS, connection refused, connect timeout, TLS) | `transient` | Nothing was posted, so a retry is safe |
| `indeterminate` (reset, header timeout, our own deadline, unknown code) | `unknown` | Bytes went out; the post may exist |

An unrecognised Node error code is `indeterminate` on purpose. Being wrong in
that direction costs a reconciliation round-trip; being wrong the other way posts
twice.

| Provider response | Outcome |
|---|---|
| 2xx with a per-platform success | `success` (both identifiers optional) |
| 2xx with a per-platform failure or rejection | `permanent`, provider's message verbatim |
| 2xx with no verdict for the platform we asked for | `unknown` |
| Ayrshare `pending` (TikTok still processing) | `unknown` |
| Ayrshare error 137 (duplicate content) | `permanent` — see below |
| 400 / 401 / 403 / 404 / 422 (and 402 on Ayrshare) | `permanent` |
| 429 | `transient`, `retryAt` from `Retry-After` |
| **5xx** | **`unknown`** — the body was already sent |
| Unexpected 202 (Upload-Post scheduled) | `unknown` — we never ask it to schedule |

### Why 5xx is not transient

The skill's table splits on whether the request body had been sent. A single
`fetch` cannot tell us, and for a publish the body is the video, so by the time a
status line comes back it always has been. `transient` would re-send it.

### Why Ayrshare's 137 is `permanent` and not `success`

Error 137 means "duplicate or similar content within the same two day period",
and the body names the earlier post. Tempting, but that earlier post may be one
the *user* made themselves — attributing it to this target would invent a
success. On this attempt nothing was posted, so `permanent` is the honest answer.
Rule 3 means publish is never retried after an ambiguous outcome, so treating 137
this way costs us no recovery path.

## Credentials

The decrypted credential arrives from the dispatcher; adapters never fetch or
decrypt one. Every outcome — `raw` **and** `message` — goes through
`createRedactor`, which strips secret-shaped field names and replaces the literal
secret anywhere it appears.

Messages need this as much as payloads do: the first version scrubbed only `raw`,
and a fixture where the provider quoted our API key back in its error message put
that key into `post_targets.failure_reason`, and from there into a webhook. The
test `keeps the credential out of every message` is what caught it.

## Constraint specs

Neither adapter enforces a platform limit. Limits are data
(`poster.platform_constraints`, rule 9) and the constraint engine checks them
before dispatch. Where a provider requires a field we may not have — a YouTube
title, for instance — the adapter sends it when present and lets the provider
reject it when absent, rather than inventing a value or a local rule.

The seeded specs are still `provisional: true`. Replacing them with the winning
provider's enforced limits is a live-half task.

## Fixtures and tests

- `test/upload-post-adapter.test.ts`, `test/ayrshare-adapter.test.ts` — one case
  per row above, plus transport cases and the redaction cases.
- `test/adapter-http.test.ts` — the sent/not-sent/indeterminate verdict and the
  scrubber.
- `test/adapter-fixtures.test.ts` — fixture hygiene: no unexplained opaque string
  gets committed.
- `test/fixtures/adapters/PROVENANCE.md` — where each fixture came from, and how
  to re-record it.

Fixtures today are **documented shapes, not live recordings**. They prove the
classification is right given that shape; they do not prove the shape is right.

## Live smoke test

```
pnpm -F @suite/poster-service test:live          # skips unless LIVE_ADAPTER_TESTS=1
LIVE_ADAPTER_TESTS=1    pnpm -F @suite/poster-service test:live   # read-only
LIVE_ADAPTER_PUBLISH=1  …                                        # posts for real
```

Read-only and publishing are separate gates because these posts are public. See
`docs/S09-acceptance.md` for what must be set up first.

## Adding another adapter

Registration is first-wins (`registry.ts`), so a direct adapter that should take a
platform from an aggregator must be listed ahead of it. Work through the
checklist in `.claude/skills/platform-adapter/SKILL.md`, and declare
`platforms` only for platforms you have actually posted to.
