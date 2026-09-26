---
name: contract-change
description: The required workflow for changing any service API in the Creator Suite — routes, request/response shapes, error codes, webhook events, reason classes, states, or auth. Use this whenever you add or modify an endpoint, field, event type, error code, or enum that crosses a service boundary, or when a session task touches packages/*-contract, the OpenAPI spec, generated clients, or docs/*-api-contract.md. Also use it when implementation reveals the contract doc is wrong or incomplete.
---

# Change an API contract

Other apps (Clipper, Trainer, future and third-party apps) depend on the published contract, not on our code (D-022). A contract change done out of order leaves the spec, SDK, doc, and service disagreeing, which is exactly the drift this repo is designed to prevent.

## Classify first

**Additive (allowed, D-015 pattern):** new optional request field, new response field, new endpoint, new event type, new error/constraint/reason code, new enum value that clients may treat as "unknown". Clients are required to ignore unknowns (contract §1, §10).

**Breaking (stop and ask):** removing or renaming anything; making an optional field required; changing a type or meaning; changing status codes for an existing case; changing auth requirements on an existing route; changing idempotency or delivery semantics. Breaking changes need a `/v2` plan and the user's approval.

If unsure, treat it as breaking and ask.

## Steps, in this order

1. **Schemas first.** Edit the zod schemas in `packages/<service>-contract/src/`. These are the single source of truth for shapes. Include `.describe()` text; it becomes the OpenAPI documentation.
2. **Regenerate.** `pnpm -F @suite/<service>-contract gen` produces the OpenAPI spec and regenerates `packages/<service>-client`. Never hand-edit generated files; if the generator output is wrong, fix the schema or the generator config.
3. **Implement** in `services/<service>`. Handlers must parse input with the contract schemas and return objects that satisfy the response schemas; don't define parallel local types.
4. **Database** if the change touches states, reasons, or events: follow the `db-migration` skill (enum value, transition row, trigger mapping, pgTAP test).
5. **Doc.** Update `docs/<service>-internal-api-contract.md` in the same commit:
   - The relevant section (shape, table, state diagram).
   - Bump the minor version in the title (v1.1 → v1.2) and add a line to the changelog at the top marking it additive.
6. **Tests.**
   - Unit/integration test of the new behavior.
   - The CI contract test (responses validate against the generated spec) must pass.
   - If a webhook payload changed, update the reference consumer in `tools/webhook-sink` and its test.
7. **Record.** Add a DECISIONS.md entry: what changed, additive or breaking, and why.

## Conventions to keep consistent

- Error envelope: `{ error: { code, message, details? } }`, snake_case codes, per-target `details` with `target_index` for validation failures.
- IDs on the wire are prefixed (`po_`, `tg_`, `cn_`, `md_`, `ev_`, `sr_`); a new resource type needs a new prefix registered in the ID codec.
- Field names snake_case on the wire; the generated client may camelCase, but the spec stays snake_case.
- Timestamps ISO 8601 UTC with `Z`.
- Lists return `{ <plural>: [...], next_cursor? }`.
- New webhook event types need: a trigger in the DB, a zod payload schema, a row in the contract §7 table, and a sink test.
