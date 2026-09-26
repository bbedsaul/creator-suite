# Creator Suite

Monorepo for the Creator Suite: **Social Poster** (built first), **Podcast Clipper** (second), and **Trainer** (third).

Backends (`services/`) and frontends (`apps/`) are separate projects. Every backend runs and deploys on its own, and every UI and future app talks to it only through its published API and generated SDK. See DECISIONS D-022.

## Start here

- `CLAUDE.md`: rules and conventions (read first; Claude Code loads it automatically)
- `DECISIONS.md`: every architecture call, append-only
- `docs/poster-m1-session-plan.md`: milestones and the session-by-session M1 plan
- `docs/social-poster-internal-api-contract.md`: the API contract (v1.1)

## Status

Bootstrap only: docs plus the Poster schema (`supabase/migrations/`, untested until session S02). Code arrives starting with session S01.

## Running Claude Code sessions

```
Read CLAUDE.md, DECISIONS.md, and docs/poster-m1-session-plan.md.
Execute session S01 only. Load only the files in its context block.
Before finishing, show evidence for each acceptance criterion,
add any new judgment calls to DECISIONS.md, commit, and tag poster-m1-s01.
```
