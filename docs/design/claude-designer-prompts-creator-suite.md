# Claude Designer Prompts — Creator Suite

*2026-09-19 · Markdown copy of the live doc "Claude Designer Prompts — Creator Suite" in this project. Copy-paste prompts for designing every screen of the Creator Suite (Social Poster, Trainer, Podcast Clipper), companion to the two PRDs and the internal API contract.*

## How to use these prompts

- Run **one prompt per Designer artifact** — don't ask for the whole suite at once.
- Start with the **Poster composer** (first prompt below): it's milestone one and establishes the design system. After it comes back, tell Designer to reuse that visual language for every later screen so the suite feels like one product.
- Under each prompt, paste the relevant slice of the PRD — the Users & Roles table plus the FRs that screen implements (noted per prompt). Whole PRDs dilute the output.
- Each prompt is self-contained, so any one works cold in a fresh Designer session.

## Social Poster

### 1. Composer & queue *(FR-05 to FR-13 — start here)*

```
Design the main screen of "Social Poster," a cross-platform social publishing app for creators. Compose-once, publish-many model: one logical post with per-platform caption variants (X, LinkedIn, Instagram, TikTok, YouTube, Facebook Pages). Key elements: a composer with platform toggle chips, per-platform character/media constraint warnings, media attachment preview, schedule picker, and a queue view showing upcoming scheduled posts with status (scheduled, dispatching, posted, failed) and permalinks on success. Include a failed-post state with a retry action. Clean, professional SaaS aesthetic — think Buffer but more modern. Desktop web, light mode.
```

### 2. Connections (OAuth vault) *(FR-01 to FR-04)*

```
Design the "Connections" settings screen for a social publishing app. Users connect social accounts once (X, LinkedIn, Instagram, TikTok, YouTube, Facebook Pages); connections are shared across a suite of sibling apps. Show: connected accounts with avatar, platform, health status (active, token expiring, revoked — needs reconnect), a prominent reconnect flow for revoked accounts, and a section showing which suite apps (Podcast Clipper, Trainer) have been granted publishing access to each connection, with revoke controls. Trust and security cues matter here. Desktop web.
```

### 3. Onboarding *(FR-01)*

```
Design the first-run onboarding for "Social Poster," a cross-platform publishing app. A new user has just signed up. Flow: welcome step framing the value ("connect once, publish everywhere"), connect-your-first-account step with platform cards (X, LinkedIn, Instagram, TikTok, YouTube, Facebook Pages) and an OAuth handoff state, then an empty-queue state that invites composing a first post with a sample pre-filled. Show progress across the steps and a skip path. Friendly but professional; the goal is one connected account and one scheduled post in under two minutes. Desktop web.
```

### 4. Plan & billing *(FR-15)*

```
Design the plan & billing settings screen for a social publishing SaaS priced by connected account count and monthly post volume. Show: current plan card, usage meters for connected accounts and posts this month with limits and overage messaging as limits approach, a plan comparison/upgrade panel (2-3 tiers), payment method on file, and invoice history. Include a state where the user has hit their post limit mid-month with a clear upgrade path. Straightforward and trustworthy — no dark patterns. Desktop web.
```

## Trainer

### 5. Creator onboarding *(Key flow: creator onboarding)*

```
Design creator onboarding for a managed training marketplace where Zoom recordings automatically become sellable courses. Flow states: application submitted (pending approval), approved welcome, connect Zoom (OAuth card explaining recordings will auto-import), connect payout account (Stripe), and a final "record your first session" empty state explaining that the next Zoom cloud recording will appear here as a draft lesson automatically. Show a step progress indicator. Reassuring, low-friction; the creator does zero file handling. Desktop web.
```

### 6. Lesson review *(FR-01 to FR-06)*

```
Design the lesson review screen for a training platform where Zoom recordings are automatically turned into polished course videos. A creator lands here after the AI pipeline processes a recording. Show: video preview player, AI-generated editable fields (lesson title, description, chapter markers on a timeline), a dead-air/filler cut list the creator can toggle per cut, thumbnail options, and a clear Approve button that makes the lesson publishable. Include a processing state (transcribing → analyzing → rendering) for lessons still in the pipeline. The feel: "review and approve in under 10 minutes," not a video editor. Desktop web.
```

### 7. Course builder & pricing *(FR-07, FR-18)*

```
Design a course builder screen for a creator on a managed training marketplace. Creators assemble approved video lessons into an ordered course, set a single price, and publish. All payments go through the platform (creators are paid revenue share — no direct student payments). Show: drag-to-reorder lesson list with duration and status, course cover/description editing, pricing panel, an earnings summary card (revenue share %, lifetime earnings, next payout), and a "generate promo clips" action that dispatches social clips of a lesson to the Social Poster app. Desktop web.
```

### 8. Student course player *(FR-08 to FR-10)*

```
Design the student-facing course player for a training marketplace. Students sign in via magic link, purchase courses, and watch streaming video. Show: video player with chapter navigation from AI-generated markers, lesson sidebar with completion checkmarks and resume position, overall course progress bar, and a "get help" affordance that reaches the course's assigned facilitator. Keep it focused and distraction-free — completion is the goal. Design both desktop and a mobile layout.
```

### 9. Facilitator console *(FR-11, FR-12, FR-18)*

```
Design a facilitator dashboard for a training marketplace. Facilitators are platform-paid staff assigned to specific courses; they support students and monitor completion, and earn a revenue share. Show: assigned courses with enrollment counts and completion rates, a student roster per course with progress and last-active, flagged students (stalled progress), a support inbox for student help requests, and a personal earnings card showing their split and payout history. Data-dense but scannable. Desktop web.
```

### 10. Admin — marketplace operations *(FR-15 to FR-19)*

```
Design an admin operations dashboard for a managed course marketplace. Admins approve creators, manage revenue-split policies, and run payouts. Show: creator approval queue, a split-policy editor (percentage splits between platform/creator/facilitator that must total 100%), an append-only ledger view of sales/refunds/payout entries, a payout run screen showing party balances with a "run payouts" action, and refund handling. Financial-grade clarity — this screen moves real money. Desktop web.
```

## Podcast Clipper

### 11. Episode intake & pipeline

```
Design the main screen of "Podcast Clipper," an app that turns podcast episodes into social clips automatically. Show: an episode list with per-episode pipeline status (transcribing → selecting moments → cutting clips → ready for review), an add-episode flow supporting direct upload and RSS feed connection ("connect your feed once, every new episode processes automatically"), and a connected-feed card showing the show's artwork and auto-processing toggle. Include an empty first-run state. Positioning on screen: "every episode becomes a week of social content." Desktop web.
```

### 12. Clip review board

```
Design the clip review board for a podcast clipper app. After processing an episode, the AI proposes a set of vertical video clips and text posts. Show: clip cards with a 9:16 video preview, hook title, and caption; text-post cards (X thread, LinkedIn post, pull quotes); per-card edit affordances (adjust clip start/end at sentence boundaries, edit caption text); approve/reject per card; and a schedule action that staggers approved items across the week via the connected Social Poster. After scheduling, cards show live status badges (scheduled, posted with permalink, failed) updated by publishing callbacks. Kanban-like flow from "proposed" to "posted." Desktop web.
```

## Trainer — authoring & selling *(added 2026-09-22, PRD v2)*

### 13. Course outline editor *(FR-20, FR-21)*

```
Design the course outline editor for a training platform. Creators build a course as a tree — Course → Module → Chapter → Item — where items are typed: video lesson, rich text, attachment, or quiz. Show: a left outline panel with nested drag-to-reorder modules/chapters/items and an add menu per level, a main editing pane for the selected item (rich text editor for text items, video attach state for video items), small origin badges on items (from Zoom pipeline, manual, AI-generated), and per-item status (draft, approved). Include an "AI scaffold" entry point: a topic prompt that generates the whole outline as draft stubs. Feels like a doc outliner, not an LMS admin. Desktop web.
```

### 14. Quiz builder *(FR-22)*

```
Design a quiz builder for a course platform where quiz questions are AI-drafted from each lesson's transcript and reviewed by the creator. Show: the source item context (lesson title + transcript snippet), a list of generated question cards (multiple choice with 4 options and marked correct answer, true/false), per-card edit-in-place, approve/reject and regenerate actions, an add-question-manually affordance, and a summary bar (6 questions · 4 approved). Include a setting toggle: "require passing to complete this chapter" with a pass threshold. Same review-and-approve feel as the rest of the suite. Desktop web.
```

### 15. Public course sales page *(FR-25, FR-26)*

```
Design the public sales page for an online course, auto-generated by the platform. Sections: hero with course title, creator name/avatar, price and buy button; a free-preview card where entering an email unlocks a preview lesson (show both locked and unlocked states); curriculum outline rendered from modules and chapters with lesson counts and durations; creator bio; and a simple FAQ/guarantee strip. Include a coupon-applied state on the price. Trustworthy and conversion-focused without dark patterns; this page is what promo clips on social link to. Design desktop and mobile layouts.
```

### 16. Checkout & enrollment *(FR-13, FR-27)*

```
Design the checkout flow for a course marketplace where the platform is the merchant of record. Steps: order summary (course, price, coupon code field with applied-discount state), payment (card fields or hosted-payment frame), processing state, and a success screen that explains magic-link access ("check your email — your sign-in link is on the way") with a resend action. Include an error state for declined payment. Keep it to one focused column, minimal distractions, clear tax line. Desktop and mobile.
```
