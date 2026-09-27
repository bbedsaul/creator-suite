# S09 aggregator scorecard — Upload-Post vs Ayrshare

**Status:** researched, not measured. Every row below is sourced from published
documentation on **2026-09-26** and from two working adapters built against it.
The **Measured** column is filled by the live half (see `S09-acceptance.md`), and
until then no adapter is registered for any platform (D-083).

Resolves PRD **OQ-1**. The criteria are the ones the session plan names:
reliability, permalink presence, idempotency and reference support, linked-account
health, pricing at 1k and 10k posts/month, and platform coverage for OQ-2.

---

## Summary

**Provisional verdict: Upload-Post**, on two criteria that are not close.

1. **It can be queried by our own reference.** `GET /api/uploadposts/history?external_id=…`
   is an exact-match filter, so `lookup()` can answer `absent`, and an ambiguous
   dispatch recovers by itself. Ayrshare has no equivalent, so the same dispatch
   ends as `failed/dispatch_outcome_unknown` and needs a human. This is the single
   most consequential difference in the whole comparison, because D-012's
   exactly-once argument rests on `lookup` being able to prove absence.
2. **Price, by roughly 6×** at the entry tier that includes TikTok.

The verdict is provisional because the decisive claim is a documentation claim.
If the live half finds that `external_id` history lags behind a publish — so an
empty result does not actually prove absence — the first reason collapses, and
with it most of the margin.

---

## Scorecard

| Criterion | Upload-Post | Ayrshare | Winner | Measured |
|---|---|---|---|---|
| **Reference lookup** (can we ask "did attempt X post?") | `GET /api/uploadposts/history?external_id=` — exact match, empty page when absent | None documented. `GET /post/{id}` needs *their* post id, which we lack after a timeout. `/history` filters platform/status/date, not our reference | **Upload-Post** | ☐ |
| **Idempotency key** | `Idempotency-Key` / `X-Idempotency-Key` headers, plus `external_id` (≤255 chars) echoed in every response | `idempotencyKey` body field, unique per User Profile; duplicate returns an error | Tie on paper | ☐ |
| **Idempotency caveat** | — | Docs state concurrent identical keys "may not be detected… processed in parallel before it has a chance to register the key". Our dispatcher never sends concurrent duplicates (`claim_due_targets` prevents it), so this is a smaller problem for us than for a general client | Upload-Post | ☐ |
| **Permalink in the publish response** | `results.<platform>.url` | `postIds[].postUrl` | Tie | ☐ |
| **Post id in the publish response** | Yes, but spread across `post_id`, `video_id`, `publish_id`, `video_urn`, `container_id` | `postIds[].id`, one consistent name | Ayrshare (cleaner) | ☐ |
| **Async/pending states** | `async_upload` is opt-in; we use sync, so a slow upload becomes our timeout → `unknown`, then a reference lookup | TikTok posts can return `status: "pending"` with no post id, and no way to resolve it later by our reference | **Upload-Post** | ☐ |
| **Linked-account health** | `GET /api/uploadposts/users` → `social_accounts.<platform>`, with `reauth_required` boolean; missing or empty string means unlinked | `GET /api/user` → `activeSocialAccounts[]` plus per-account `refreshDaysRemaining` / `refreshRequired` | **Ayrshare** — days-remaining supports a real `expiring` warning; Upload-Post only distinguishes active from revoked | ☐ |
| **Health response caching** | Not documented | "Responses are cached for up to 60 seconds" | Ayrshare (documented) | ☐ |
| **Error detail** | Per-platform `error`, `error_code`, `failure_stage`, `skipped` + `skip_reason` | `errors[]` with numeric codes (e.g. 137 duplicate content) and per-platform messages | Tie | ☐ |
| **Rate-limit signalling** | 429 with a `usage` object (`count`, `limit`, `last_reset`) | 429 | Upload-Post (tells us the quota) | ☐ |
| **Reliability** | — | — | **Cannot be scored without the live half** | ☐ |

## Pricing

Both providers' own pricing pages, 2026-09-26. Monthly, billed monthly.

| | Upload-Post | Ayrshare |
|---|---|---|
| Free tier | 10 uploads/month, **TikTok excluded** (YouTube included) | none |
| Entry paid tier | **Basic $24** ($16 annual) — 5 profiles, "unlimited uploads… all platforms including TikTok" | **Premium $149** — 1 profile, up to 14 accounts |
| Next tier | Professional $50 — 25 profiles | Launch $299 — 10 profiles |
| **At 1,000 posts/month** | **$24** | **$149** |
| **At 10,000 posts/month** | **$24** (uploads unlimited; watch the 300 video-minutes/month on Basic — 10k 60-second videos is 10,000 minutes, so Advanced $147 or Business $438) | **$149** if within the 500 posts/month quota — it is not; 10k posts needs Launch or Business, $299–$599 |

Two honest qualifications:

- Upload-Post's "unlimited uploads" is bounded in practice by **video minutes per
  month** (Basic 300, Professional 1,000, Advanced 3,000, Business 10,000). For
  60-second clips that is the real limit: 1k posts/month ≈ 1,000 minutes →
  Professional $50; 10k posts/month ≈ 10,000 minutes → Business $438. The single
  headline number above understates it, so both readings are given.
- Ayrshare's quotas are per User Profile (`monthlyPostQuota` was 500 in the
  documented example). Multi-tenant use is what their Business tier prices, at
  $599 for 30 profiles plus $8.99/profile beyond.

Corrected for video minutes, at **1k posts/month it is roughly $50 vs $149**, and
at **10k roughly $438 vs $599** — still Upload-Post, by less at scale.

*(Upload-Post's marketing page claims Ayrshare costs "$49+/month". Ayrshare's own
pricing page says $149 for the entry tier. The competitor's number is not used
here.)*

## Platform coverage (OQ-2)

| Our platform | Upload-Post | Ayrshare |
|---|---|---|
| `tiktok` | `tiktok` (paid tiers only) | `tiktok` |
| `youtube` | `youtube` (free tier too) | `youtube` |
| `instagram` | `instagram` | `instagram` |
| `linkedin` | `linkedin` | `linkedin` |
| `x` | `x` | `twitter` |
| `facebook_pages` | `facebook` | `facebook` |

Both cover all six platforms in `poster.platforms`. Beyond them, Upload-Post lists
Threads, Pinterest, Reddit, Bluesky, Discord, Telegram and Google Business;
Ayrshare lists 14 networks including Bluesky, Snapchat, Telegram, Threads,
Pinterest, Reddit and Google Business. Coverage is not a differentiator.

## What the live half must settle

In priority order — the first item is the one that could change the verdict:

1. **Does `external_id` history lag a publish?** If a just-accepted upload does
   not appear immediately, then "empty history" does not prove absence, and
   `lookup` returning `absent` would cause the double post the whole design exists
   to prevent. If it lags, the adapter needs a settle window, and its
   `supportsReferenceLookup` claim weakens.
2. **Does `in_progress` carry `external_id`?** The adapter currently treats a
   non-empty `in_progress` as "could be ours" and answers `unknown`. If entries
   are identifiable, that can be narrowed; if not, a busy account degrades to
   `unknown` more often than necessary.
3. **Reliability**: post the same video N times through both and count failures,
   ambiguous outcomes, and time-to-permalink.
4. **Do permalinks actually arrive**, and how long after acceptance? TikTok
   processing delay is the risk on both.
5. **Does TikTok accept public posts** through each provider's app audit status,
   or do they land private?
6. **Real enforced limits** for the constraint specs, replacing `provisional`.

## Decisions this feeds

- **D-082** — splitting S09 into a documented half and a live half.
- **D-083** — both adapters built; `platforms: []` until verified.
- **D-084** — `supportsReferenceLookup` as a separate declaration, and Ayrshare's
  `lookup` never answering `absent`.
- **D-085** — `platformId` added to `ConnectionCheckRequest`.
- **D-086** — 5xx classified `unknown`, and the sent/not-sent split in `http.ts`.
- **D-087** — no provider SDKs.
- **D-088** — `platformPostId` optional on `success` and `found`.
- **D-089** — redaction covers `message`, not only `raw`.
- **D-090** — Ayrshare error 137 is `permanent`, not `success`.
- **D-091** — two gates on the live suite; publishing needs its own.
- **D-092** — fixture provenance and the opaque-string tripwire.
