---
name: creator-suite-ui
description: Design system and frontend rules for every Creator Suite UI (poster-web, clipper-web, trainer-web) — design tokens, typography, color, components, API access, auth, and live status updates. Use this whenever you build or change anything under apps/ or packages/ui, create a screen, component, or style, wire a UI to an API, or implement anything from docs/design/, even small visual tweaks. Pair it with the general frontend-design skill for aesthetic judgment.
---

# Creator Suite UI

All three products must feel like one product (D-003), and every UI must stay a pure API client (D-022, D-024). Those two rules shape everything below.

## Architecture rules

- Apps are **Vite + React + TypeScript SPAs** (D-025), one per product under `apps/`.
- Imports allowed: `packages/ui`, `packages/*-contract`, `packages/*-client`, and npm packages. Nothing from `services/*` or `packages/server-core`; `pnpm lint:deps` enforces it.
- **All data goes through the generated client** (`@suite/poster-client`, etc.). No `fetch` to hand-built URLs, no Supabase table queries. Supabase JS is used for sign-in and session refresh only.
- Auth: send the Supabase session JWT as the bearer token (user mode, D-023). The API base URL comes from `VITE_<SERVICE>_API_URL`.
- Live status (queue, clip board) comes from the service's SSE endpoint, reconciled with a refetch on reconnect. Treat the `state` field as authoritative, never event order.
- Surface API errors from the standard envelope. For `422 constraint_violation`, map each `details[].target_index` back to the specific platform chip or field.

## Design tokens

Tokens live in `packages/ui/src/tokens.css` as CSS custom properties and are the **only** place raw values appear. Components reference variables, never hex codes or pixel font sizes.

The design system was extracted from the Poster composer design:
- **Display type:** Sora. **Body/UI type:** Instrument Sans. Load both from Google Fonts with system fallbacks.
- **Accent:** teal. **Neutrals:** warm (not blue-gray).

> **Exact values are not in this repo yet.** Before building the first screen (M3), export the real tokens from the Creator Suite design system into `tokens.css`. Until then, placeholders are marked `/* TODO: export from design system */`. Do not invent final hex values or ship placeholder values to production; if a task needs tokens that don't exist yet, stop and ask.

Required token groups: `--color-*` (bg, surface, border, text, text-muted, accent, accent-contrast, success, warning, danger, info), `--font-display`, `--font-body`, `--font-mono`, `--text-*` (size scale), `--space-*`, `--radius-*`, `--shadow-*`, `--duration-*`. Define light values on `:root` and dark values under `[data-theme="dark"]`; the first screens are light-mode only, but components must not hard-code light assumptions.

## Components

Shared components live in `packages/ui` and are used by all apps. Build a component there, not in an app, as soon as a second app would need it. Core set, in rough build order:

- Button, IconButton, Input, Textarea, Select, Toggle, Checkbox
- **StatusBadge**: one component for every lifecycle state across products (`scheduled`, `dispatching`, `posted`, `failed`, `paused`, `canceled`, plus pipeline states). Colors come from a state → token mapping in one place.
- **PlatformChip**: platform icon + name + selected/constraint-warning states. Use simple generic icons; don't copy brand logos without checking brand-asset rules.
- Card, Panel, Modal, Drawer, Toast, EmptyState, Skeleton
- ConstraintWarning: inline per-platform message from a 422 detail

## Screens

Screen specs are the prompts in `docs/design/claude-designer-prompts-creator-suite.md`, numbered 1–16. When building a screen, implement what its prompt describes and the FRs it lists; if the prompt and PRD disagree, the PRD wins and you note it.

## Quality bar

- Keyboard reachable, visible focus rings, labels on every input, and color is never the only signal (status badges carry text).
- Every data view has loading (skeleton), empty, and error states.
- Responsive down to 360px wide for the student player and sales pages; desktop-first elsewhere.
- No dark patterns on billing or upgrade screens (the designer prompts say so explicitly).
