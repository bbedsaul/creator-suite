---
name: db-migration
description: Conventions for writing or changing Postgres/Supabase schema in the Creator Suite — migrations, tables, enums, triggers, functions, RLS policies, and pgTAP tests. Use this whenever you create or edit anything in supabase/migrations or supabase/tests, add a table or column, change a state machine, write a SQL function, or touch RLS, even for a one-line change. The database enforces this project's invariants, so SQL mistakes here are the most expensive kind.
---

# Database migrations

The database is where invariants live (CLAUDE.md rule 1): ownership, legal state transitions, exactly-once claims, "failed requires a reason", money rules. App code calls functions; it doesn't reimplement their rules. Every migration you write should make an illegal state *unrepresentable*, not merely discouraged.

## Files and naming

- Location: `supabase/migrations/<YYYYMMDDHHMMSS>_<product>_<topic>.sql`. The Supabase CLI requires the timestamp prefix. Use a timestamp later than every existing file.
- Never edit a migration that has been committed and tagged in a session; write a new one. Before the first tag, fixing in place is fine.
- One product per schema: `poster`, `clipper`, `trainer`. Shared tables go in `core`. Never create objects in `public`.
- Header comment: product, what the migration does, and which DECISIONS entries it implements.

## Required patterns

**Tables**
- `id uuid primary key default gen_random_uuid()`; `created_at`/`updated_at timestamptz not null default now()` with the schema's `touch_updated_at()` trigger.
- Every user-owned row has `user_id uuid not null references auth.users (id) on delete cascade`.
- Cross-table ownership uses **composite foreign keys** so a row can't reference another user's data: give the parent `unique (id, user_id)` and reference `(child_fk, user_id)`. Example in the Poster schema: `post_targets (connection_id, user_id, platform_id) → connections (id, user_id, platform_id)`.
- Encode rules as `check` constraints wherever possible (e.g. `check ((state = 'failed') = (reason_class is not null))`).
- Enums for closed sets that code switches on. Adding an enum value is fine (`alter type … add value`); renaming or removing one is a breaking change: stop and ask.

**State machines**
- Legal transitions live in a transitions table (see `poster.target_transitions`) and a `before update` trigger rejects anything else with `errcode = 'check_violation'`.
- Adding a transition = one `insert` into that table plus a test. Also update the contract doc's state diagram (use the `contract-change` skill).

**Functions**
- Anything that must be atomic or fenced (claims, completions, money movement) is a SQL function, not app-side read-then-write.
- `security definer` functions always have `set search_path = ''` and fully qualify every object (`poster.post_targets`, `auth.uid()`).
- Claims use `for update skip locked` inside a CTE, then `update … returning`. Completions are **fenced**: they update only `where claimed_by = p_worker` and return `false` if fenced out.
- Privileges: functions are private by default (`alter default privileges … revoke execute … from public`). Grant `execute` explicitly to `service_role` only.

**RLS**
- `enable row level security` on every table, in the same migration that creates it.
- The `authenticated` role gets **select-only** policies on its own rows: `using (user_id = (select auth.uid()))` (the subselect form is faster). Writes go through the service API as `service_role` (D-024).
- Sensitive tables (credentials, attempts, idempotency keys, outbox) get RLS enabled and **no** policy. Add a comment saying so.
- Views use `with (security_invoker = true)`.

**Events**
- Webhook/outbox rows are written only by triggers, in the same transaction as the state change (D-014). Never have app code insert into an outbox table.

## Tests are part of the migration

Every migration ships with pgTAP tests in `supabase/tests/<product>_<topic>.test.sql`. At minimum:
- Each new constraint or trigger: one test that the illegal case raises (`throws_ok`) and one that the legal case passes.
- Each claim function: concurrent claims return disjoint rows (use two sessions or `dblink`).
- Each fenced function: the wrong worker gets `false` and changes nothing.
- RLS: as `authenticated` user A, you can't see user B's rows, and can't see no-policy tables at all (`set local role authenticated; set local request.jwt.claims = '{"sub":"…"}'`).

## Checklist before committing

- [ ] `supabase db reset` applies all migrations cleanly from zero.
- [ ] `supabase test db` passes.
- [ ] Generated types regenerated (`supabase gen types typescript`).
- [ ] No object in `public`; every table has RLS enabled.
- [ ] Every `security definer` function has `set search_path = ''`.
- [ ] Any new judgment call is in DECISIONS.md.
