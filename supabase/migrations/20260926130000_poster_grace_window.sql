-- =============================================================================
-- Social Poster · grace window as a single source of truth
--
-- The 60 minute revocation grace window (contract §9 step 5) was duplicated as a
-- literal default in two functions, so M2's job of validating that number would
-- have meant remembering both places. It now lives in poster.grace_window(),
-- which both functions default to. Implements D-052.
--
-- The four bootstrap migrations are tagged and frozen (D-038), so this is a new
-- migration that replaces the two function bodies rather than an edit to them.
-- The bodies below are unchanged apart from the default expression.
-- =============================================================================

-- Single source for the window. `stable` rather than `immutable`: a later
-- migration may read it from a settings table, and immutable would let the
-- planner fold today's value into cached plans.
create function poster.grace_window() returns interval
language sql stable set search_path = '' as $$
  select interval '60 minutes'
$$;

comment on function poster.grace_window() is
  'Revocation grace window (contract §9). Change here, not at call sites. '
  'Validated against real reconnect behaviour in M2.';

-- Reconnect: within the window a target goes back to scheduled, past it the post
-- is too stale to send and fails instead.
create or replace function poster.resume_connection_targets(
    p_connection uuid,
    p_grace      interval default poster.grace_window())
returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  update poster.post_targets
     set state        = case when due_at >= now() - p_grace
                             then 'scheduled'::poster.target_state
                             else 'failed'::poster.target_state end,
         reason_class = case when due_at >= now() - p_grace
                             then null
                             else 'token_revoked_expired'::poster.reason_class end
   where connection_id = p_connection and state = 'paused';
  get diagnostics n = row_count;
  return n;
end $$;

-- Sweeper: paused targets whose grace ran out without a reconnect.
create or replace function poster.expire_paused_targets(
    p_grace interval default poster.grace_window())
returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  update poster.post_targets
     set state = 'failed', reason_class = 'token_revoked_expired'
   where state = 'paused' and due_at < now() - p_grace;
  get diagnostics n = row_count;
  return n;
end $$;

-- Migration 4's blanket grants covered only the functions that existed then, so
-- the new one needs its own.
revoke execute on function poster.grace_window() from public, anon, authenticated;
grant  execute on function poster.grace_window() to service_role;
