---
name: run-session
description: The required workflow for executing a numbered build session (S01, S02, …) from docs/*-session-plan.md in the Creator Suite repo. Use this whenever the user says "run S03", "next session", "do session N", "continue the plan", or asks you to start, resume, or finish any planned milestone work, even if they don't say the word "session". Covers context loading, scope control, acceptance evidence, DECISIONS.md logging, commit, and tagging.
---

# Run a session

Sessions are the unit of work in this repo. Each has a context block, tasks, and acceptance criteria in a session plan (currently `docs/poster-m1-session-plan.md`). The point of the ritual is that every session ends in a provably done, tagged state that the next session can trust.

## 1. Orient (before touching code)

1. Read `CLAUDE.md` and `DECISIONS.md` in full. Note any decision marked **Proposed** that this session depends on; if one is unconfirmed and the session would bake it in, say so and ask before proceeding.
2. Find the session in the plan. Read its **Context** list and load only those files. Other docs are out of scope unless a task can't be done without them; if you need one, say which and why.
3. Check the previous session's tag exists (`git tag --list '*-s*'`) and the tree is clean. If the tree is dirty, stop and report; don't build on unknown state.
4. Restate the session goal, tasks, and acceptance criteria back in a short checklist. That checklist is the contract for this session.

## 2. Execute

- Do the listed tasks and nothing else. Useful ideas outside scope go in a "Follow-ups" note at the end, not in the diff.
- Follow the other project skills when their areas come up: `db-migration` for any SQL, `contract-change` for any API shape, `platform-adapter` for adapters, `creator-suite-ui` for frontend, `media-pipeline` for ffmpeg/whisper/LLM steps.
- If a task conflicts with a doc (PRD, contract, CLAUDE.md), stop and ask. Never silently pick one.
- Commit in small, working steps as you go (`wip:` prefix is fine); the session tag marks the finished state.

## 3. Prove

For every acceptance criterion, produce evidence the user can check:

| Criterion type | Evidence |
|---|---|
| Behavior | Test name(s) and the passing output |
| Command works | The command and its actual output |
| API behavior | curl request + response |
| Invariant | pgTAP test name and output |
| Performance | The measurement method and numbers |

"It should work" is not evidence. If a criterion can't be proven, mark it **NOT MET** with the reason; don't tag the session.

Always also run the repo-wide gates: `pnpm -r build`, `pnpm -r test`, `pnpm lint:deps`, and `supabase test db` once they exist.

## 4. Record

- Any judgment call not already in `DECISIONS.md` gets a new numbered entry: `**D-0NN · Proposed · YYYY-MM-DD** — decision. *Why:* reason.` Append only; to change an old decision, add a new entry that says `supersedes D-0XX` and mark the old one `Superseded by D-0NN`.
- If the session changed how to run anything, update the Commands section of `CLAUDE.md`.

## 5. Close

1. Final commit: `feat(<area>): S<NN> — <session title>` with a body listing acceptance criteria and their evidence locations.
2. Tag: `<product>-<milestone>-s<NN>`, e.g. `poster-m1-s03`.
3. Report to the user:
   - Acceptance table: criterion, MET/NOT MET, evidence.
   - New DECISIONS entries (numbers + one line each), flagging any that need confirmation.
   - Follow-ups discovered.
   - What the next session needs that isn't in place yet.
