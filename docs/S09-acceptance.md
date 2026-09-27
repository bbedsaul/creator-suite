# S09 acceptance — the live half

**Status:** open. S09 is split (D-082). The documented half — both adapters, fixture
tests, and the researched scorecard — is done in code. This document is the checklist
for the *live* half, which needs credentials only Bill can obtain.

S09's acceptance criteria are:

1. A DECISIONS entry exists with the scorecard.
2. A real scheduled post lands on both platforms via the Poster API, with permalinks
   in `post.posted` webhooks.

Criterion 1 is met in researched form and gets a measured column once the steps below
are done. Criterion 2 cannot be met without the accounts below, so **S09 is not tagged
until this checklist is complete**.

---

## Step 1 — pricing and capability check ✅ DONE (2026-09-26)

Both providers were checked before any signup. Full results in
`docs/S09-aggregator-scorecard.md`; what matters for the purchase decision:

| | Upload-Post | Ayrshare |
|---|---|---|
| Free tier | 10 uploads/month, **TikTok excluded**, YouTube included | none |
| Entry tier with TikTok | **Basic $24/mo** ($16 annual) | **Premium $149/mo** |
| Lookup by our own reference | **Yes** — `history?external_id=` | **No** |

**Buy Upload-Post Basic ($24).** For Ayrshare there is no free path to TikTok, so a
faithful comparison costs $149 for one month.

**A cheaper option worth considering:** run the spike on **Upload-Post only**, on the
free tier, for **YouTube only** — $0, no card. That proves the end-to-end path (real
post, real permalink, real `post.posted` webhook, reference lookup) and leaves only
"is Ayrshare better?" unanswered. Given the $24-vs-$149 gap and that Ayrshare cannot
be queried by our reference at all, the answer to that is already unlikely to be yes.
If the goal is to finish M1 rather than to be thorough about a provider we probably
will not pick, this is the better trade.

The rest of this document assumes the full two-provider comparison. For the cheap
path, skip Ayrshare everywhere and use `youtube` alone.

## Step 2 — accounts (Bill, ~45 min)

Two aggregator accounts:

1. **Upload-Post** — sign up, get an API key.
2. **Ayrshare** — sign up, get an API key.

Two throwaway social accounts, linked to *both* aggregators from inside their
dashboards:

1. A **TikTok** account.
2. A **YouTube channel** (a channel, not just a Google account — aggregators need a
   channel id).

Notes that save time:

- Linking is an interactive OAuth flow in each aggregator's dashboard. It needs a
  browser and credentials on the social side, so Claude cannot do this part at all.
- Turn **off 2FA** on the throwaway accounts, or have the authenticator to hand; 2FA
  commonly stalls these flows.
- Test posts are real posts. Use accounts that can be deleted afterwards. TikTok may
  force them to private depending on the aggregator's app-audit status — that is itself
  one of the things worth observing.
- Link the **same two accounts to both aggregators**. The spike's design is posting
  identical content through both, so the comparison is only clean if the destinations
  are identical.

## Step 3 — the video (Bill, 1 min)

One **60-second vertical video**, roughly 1080x1920, H.264/AAC in an `.mp4`. A screen
recording is fine. Put it anywhere and give Claude the absolute path; it gets probed
against the seeded constraint specs before use.

## Step 4 — the keys (Bill, 2 min)

Append to `.env.local` at the repo root — already gitignored (`.env.*`) and already
loaded by `--env-file-if-exists`:

```
UPLOAD_POST_API_KEY=...
UPLOAD_POST_USER=...
AYRSHARE_API_KEY=...
```

Do this directly: `! echo 'AYRSHARE_API_KEY=...' >> .env.local` in a Claude Code
session, or just open the file in an editor. **Do not paste the values into chat** —
anything in the conversation lands in the transcript; anything in `.env.local` does
not. Claude never needs to see the values, only to know they are set.

These names follow the existing `SEED_SECRET_*` convention and the
`[A-Z][A-Z0-9_]*` restriction D-080 puts on secret refs. If a provider needs an extra
identifier (Ayrshare's Business tier uses a per-profile key alongside the API key),
Claude will name the exact variable to add.

## Step 5 — reachable media (a decision from Bill)

The aggregators' servers fetch the video **by URL**. Today they cannot:

- Storage is local Supabase at `127.0.0.1:54321`, unreachable from the internet.
- `Rendition.url` carries a raw `storage_path`, not a fetchable URL (S05 follow-up).
- `MediaStorage` has `createSignedUpload` but no signed *download* method
  (`services/poster/src/media/storage.ts`).

Adding `createSignedDownload` and resolving renditions to real URLs is Claude's work.
Reachability is a choice:

| Option | Effort | Notes |
|---|---|---|
| `cloudflared tunnel --url http://127.0.0.1:54321` **(recommended)** | 2 min, no account | Ephemeral URL, fine for a one-day spike |
| Hosted Supabase project | ~1 hour | Needed for S10's staging anyway, so not wasted |
| Upload the video to any public URL by hand | 5 min | Cheapest, but skips signed-URL work S10 needs proven |

Recommendation: tunnel for S09, hosted project properly in S10, where deployed staging
is an explicit exit criterion.

## Step 6 — the live run (Claude, once the above exists)

The suite that does this already exists and is gated
(`services/poster/test/live/adapters.live.test.ts`, D-091):

```
LIVE_ADAPTER_TESTS=1   pnpm -F @suite/poster-service test:live   # read-only, safe
LIVE_ADAPTER_PUBLISH=1 LIVE_ADAPTER_TESTS=1 LIVE_MEDIA_URL=... \
                       pnpm -F @suite/poster-service test:live   # posts for real
```

Run the read-only tier first: it already settles the criterion the scorecard turns on,
by checking that Upload-Post answers `absent` for an attempt that never happened and
that Ayrshare answers `unknown`.

Then:

1. Add `createSignedDownload`; wire `Rendition.url` to a real signed URL.
2. Store each aggregator key through the vault (`credentials.store`,
   `kind: 'aggregator_profile'`) and create a `poster.connections` row per platform per
   provider.
3. Run the same 60s video through both providers to both platforms via the real API.
4. Confirm the `post.posted` webhook carries a permalink.
5. Re-record fixtures from the live responses, scrubbed.
6. Fill the measured column of the scorecard, register the winner in the adapter
   registry, and replace the `provisional: true` constraint specs with the winner's
   enforced limits.
7. Tag `poster-m1-s09`.

## Credential handling

CLAUDE.md rule 5 governs: the keys never appear in a log line, an error message, an
adapter's `raw` payload, a DECISIONS entry, a commit, or a test fixture. Every decrypt
writes `vault_access_log`. The only files that reference them are `.env.local`
(gitignored) and the vault. Recorded fixtures are scrubbed before they are committed,
and the session report names which files were recorded and what was removed.

## Cost

About an hour of setup, plus one month on each provider's lowest tier that includes
TikTok and YouTube. Two throwaway social accounts, deletable afterwards.
