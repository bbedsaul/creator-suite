# Podcast Clipper — PRD

*Creator Suite · Rebuilt from the project chat "Podcast to social media snippets workflow." The original formatted PDF is still downloadable in that chat.*

## 1. Summary

Podcast Clipper is a self-serve micro-SaaS that turns a podcast episode (audio or video) into ready-to-publish social content: short vertical video clips with captions, plus text posts (threads, LinkedIn posts, pull quotes). The user uploads or connects an episode source; the pipeline transcribes it, an LLM selects the strongest moments and drafts the copy, video clips are cut and captioned automatically, and everything is scheduled and published to the user's connected social accounts through the Social Poster service.

It is the second product in the Creator Suite. It shares the media pipeline with the Training Application and is the first internal consumer of the Social Poster's publishing API. Positioning: "every episode becomes a week of social content, automatically."

## 2. Problem

Podcasters know clips drive discovery, but producing them is a grind: scrubbing hours of audio for highlights, editing vertical video, writing captions per platform, and posting on a schedule. Hiring editors costs hundreds per episode; existing clip tools still leave selection review, copywriting, and posting as separate manual chores across multiple products.

## 3. Goals and Non-Goals

### Goals
- Hands-off pipeline: episode in → approved clips and posts out, with one review step in between.
- Both output types from one pass: vertical video clips (with captions and hook titles) and text posts (thread, LinkedIn, quotes).
- Quality clip selection: complete thoughts, strong hooks, clean sentence-boundary cuts — never mid-word.
- Scheduling and publishing handled inside the product via the Social Poster; no exporting files to other tools.
- Recurring automation: connect an RSS feed once, every new episode processes automatically.
- Self-serve subscription with usage-based fairness (processing minutes).

### Non-Goals (v1)
- Full podcast hosting, distribution, or RSS generation.
- A timeline video editor — users adjust clip boundaries and text, not frames and layers.
- Direct platform integrations built in-house — publishing goes through the Social Poster (which may itself wrap an aggregator API initially).
- Team seats and collaboration workflows.
- Analytics beyond basic post-status confirmation (deeper analytics live in the Social Poster roadmap).

## 4. Users and Roles

| Role | Who | Primary jobs |
|---|---|---|
| Creator (user) | Podcaster, or the marketer/VA running their content | Connect sources and social accounts, review and approve generated clips/posts, manage schedule and subscription |
| Admin | Platform operator | Usage and cost monitoring, support, abuse controls, plan management |

Primary segments: independent podcasters (1 show, weekly cadence) and small businesses using a podcast as marketing. No student/facilitator layer exists in this product — tenancy is single-sided.

## 5. Product Description

### 5.1 Ingestion

- **Direct upload:** audio (mp3, m4a, wav) or video (mp4, mov), up to 4 hours.
- **RSS watch:** connect a podcast feed; new episodes enqueue automatically.
- **Cloud folder:** Google Drive folder watch for teams that drop finished episodes there.
- Audio-only episodes are flagged: video clip generation switches to audiogram mode (waveform + cover art) while text outputs are unaffected.

### 5.2 Pipeline

- **Transcribe:** audio extracted/compressed, chunked as needed, Whisper transcription with word-level timestamps, chunks stitched with corrected offsets.
- **Select & draft:** a single structured-output LLM pass returns 3–6 clip candidates (start/end on sentence boundaries, 30–75s, hook title, caption) plus text posts (X thread, LinkedIn post, pull quotes). Output is schema-validated; invalid responses are retried with error feedback.
- **Cut & caption:** FFmpeg cuts at absolute timestamps, crops to 9:16, burns word-timed captions; audiogram rendering for audio-only sources.
- **Review:** the user sees a review board — play each clip, nudge boundaries (snap to sentence timestamps), edit titles, captions, and post text, toggle items on/off.
- **Schedule & publish:** approved items are staggered across a configurable window (e.g., 5 clips over 7 days) and dispatched via the Social Poster API; per-item status (scheduled, posted, failed) is surfaced back.

### 5.3 Accounts and Billing

- Subscription tiers defined by processing minutes per month and connected show count; Stripe billing with metered overage on minutes.
- Social account connections are owned by the Social Poster service (shared OAuth token vault); the Clipper requests scopes, never stores platform tokens itself.
- Free trial: one episode processed end-to-end with posting enabled, watermark-free.

## 6. Key User Flows

- **Onboarding:** sign up → connect social accounts (Poster OAuth) → upload first episode or paste RSS URL → review board → approve → first clips scheduled.
- **Recurring episode:** RSS poll detects new episode → pipeline runs → user notified "your clips are ready" → review → approve (or auto-approve if enabled).
- **Auto-pilot mode:** opt-in per show; approved-by-default publishing with a cancellation window before each post goes out.
- **Failure recovery:** failed transcription/render/post surfaces in the dashboard with retry; failures never silently drop an episode.

## 7. Functional Requirements

### Ingestion
- **FR-01** — Direct upload of audio/video up to 4 hours with resumable uploads.
- **FR-02** — RSS feed connection with polling; new episodes enqueue automatically and exactly once.
- **FR-03** — Google Drive folder watch as an alternate source.
- **FR-04** — Media-type detection routes audio-only sources to audiogram rendering.

### Processing
- **FR-05** — Whisper transcription with word-level timestamps; long files chunked and re-stitched with corrected offsets.
- **FR-06** — LLM selection pass returns schema-validated JSON (clips + text posts); semantic validation covers boundary order, clip length range, character limits; invalid output is retried with the validation error fed back, max 3 attempts.
- **FR-07** — FFmpeg cutting at absolute timestamps, 9:16 crop, burned captions from word timings; configurable caption style.
- **FR-08** — Audiogram mode: waveform + episode art composited over clipped audio, same timestamps, mp4 output.
- **FR-09** — Pipeline steps are idempotent, resumable jobs with per-step status; render jobs dispatch to a worker pool separate from web infrastructure.

### Review & Publishing
- **FR-10** — Review board: playback, boundary nudge snapped to sentence timestamps (triggers re-render of that clip only), inline editing of titles/captions/post text, per-item include/exclude.
- **FR-11** — Scheduling engine staggers approved items over a user-configured window and time-of-day preferences.
- **FR-12** — Publishing dispatches through the Social Poster API; per-item lifecycle (scheduled → posted → failed) shown with retry for failures.
- **FR-13** — Auto-pilot per show: auto-approve with a cancellation window; any item can be pulled before its post time.

### Accounts & Billing
- **FR-14** — Stripe subscriptions with processing-minute metering; usage visible in-app; hard cap with upgrade prompt rather than surprise overage by default.
- **FR-15** — Social connections managed by the Social Poster's shared OAuth vault; disconnect/reconnect flows surfaced in the Clipper UI.
- **FR-16** — Admin views: per-user processing cost, failure rates, abuse flags (e.g., copyrighted-content complaints), plan overrides.

## 8. Non-Functional Requirements

- **NFR-01** — A 60-minute episode completes transcription + selection + all clip renders in under 15 minutes at launch scale.
- **NFR-02** — COGS per episode tracked (Whisper + LLM + render + storage) and kept under 25% of the per-episode revenue at target pricing.
- **NFR-03** — No silent data loss: every enqueued episode reaches a terminal state (completed, failed-with-reason, or user-cancelled).
- **NFR-04** — Source files and rendered clips stored with signed-URL access only; retention policy per plan tier.
- **NFR-05** — Publishing tokens never transit the Clipper's own storage; all platform calls go through the Poster service boundary.
- **NFR-06** — RLS enforces per-user isolation on all tables; single-sided tenancy consistent with packages/core.

## 9. System Architecture

- **packages/core** — auth, tenancy, Stripe billing, shared UI.
- **packages/media-pipeline** — shared with the Training Application: job queue (pg-boss/BullMQ), ingest adapters, Whisper step, LLM structured-output step, FFmpeg render dispatch.
- **apps/clipper** — this product: review board, scheduling, clip-selection pipeline head, billing UI.
- **apps/poster** — publishing dependency: OAuth vault, scheduling execution, platform adapters (may wrap an aggregator API such as Upload-Post/Ayrshare initially).

Platform services: Supabase (Postgres, auth, storage, RLS), Stripe (subscriptions + metering), worker pool for FFmpeg renders (CPU adequate for clip-length renders; GPU optional), object storage with signed URLs.

## 10. Milestones

| Milestone | Scope | Exit criteria |
|---|---|---|
| M1 — Pipeline | Upload ingest, transcription, selection, clip render | A real episode produces 3–6 watchable captioned clips plus text posts with no manual editing |
| M2 — Review & Publish | Review board, scheduling, Poster integration | A user approves a batch and it posts to two platforms on schedule |
| M3 — Self-Serve | Stripe billing, RSS automation, trial flow | A stranger can sign up, pay, connect a feed, and receive posted clips with zero operator involvement |
| M4 — Auto-Pilot | Auto-approve mode, audiograms, caption styles | A weekly show runs hands-off for a month with no failed or missed episodes |

## 11. Success Metrics

- Activation: % of signups whose first episode results in at least one published post.
- Approval rate: % of AI-selected clips approved without boundary or copy edits (selection quality proxy; target rising over time).
- Time-to-clips: episode ingest to review-ready.
- Retention: shows still auto-processing after 60 days.
- COGS per episode vs. plan revenue (NFR-02).
- MRR, trial-to-paid conversion.

## 12. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Crowded market (Opus Clip, Vizard, Castmagic) | Compete on end-to-end automation including posting, suite bundling, and small-business positioning — not on editor features |
| Clip selection quality disappoints | Approval-rate metric from day one; prompt iteration loop; boundary-nudge UX makes near-misses salvageable |
| Social platform API access / posting reliability | Poster wraps an aggregator initially; direct integrations only when volume justifies the approval processes |
| Processing costs erode margin on long episodes | Minute metering, per-plan caps, compressed audio to Whisper, single LLM pass per episode |
| Users upload content they don't own | ToS + complaint handling + admin abuse flags (FR-16); takedown process before scale |

## 13. Open Questions

- **OQ-1** — Pricing anchors: per-show plans vs. pure minute metering; where does the hard cap sit per tier?
- **OQ-2** — Which platforms at launch? (Shortlist: TikTok, Instagram Reels, YouTube Shorts, X, LinkedIn — confirm order.)
- **OQ-3** — Auto-pilot default: opt-in from day one, or M4 only after approval-rate data justifies it?
- **OQ-4** — LLM provider per pass (cost vs. selection quality) and whether users can regenerate with different "content personas."
- **OQ-5** — Does the Clipper share accounts/billing with the rest of the suite at launch (one subscription, many apps) or bill standalone? (Pairs with Poster OQ-3.)
