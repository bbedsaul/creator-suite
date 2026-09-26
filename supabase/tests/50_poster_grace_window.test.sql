-- =============================================================================
-- Poster · the grace window has exactly one definition (D-052).
--
-- Behaviour at the boundary is already covered in 30_poster_events_pause. What
-- these assertions defend is the thing that actually rots: that neither function
-- carries its own copy of the number, so M2 can retune the window by changing
-- one function and not discover a second literal later.
-- =============================================================================
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(7);

select has_function('poster', 'grace_window', 'the window has a single definition');

select is(poster.grace_window(), interval '60 minutes',
  'the window is 60 minutes, the value contract §9 proposes');

select is(
  (select provolatile from pg_proc
    where proname = 'grace_window' and pronamespace = 'poster'::regnamespace),
  's',
  'it is stable, not immutable, so a later settings-backed version cannot be folded into cached plans');

-- The defaults must reference the function, not restate the interval.
select matches(
  (select pg_get_expr(proargdefaults, 0) from pg_proc
    where proname = 'resume_connection_targets' and pronamespace = 'poster'::regnamespace),
  'grace_window',
  'resume_connection_targets defaults to grace_window()');

select matches(
  (select pg_get_expr(proargdefaults, 0) from pg_proc
    where proname = 'expire_paused_targets' and pronamespace = 'poster'::regnamespace),
  'grace_window',
  'expire_paused_targets defaults to grace_window()');

select doesnt_match(
  (select pg_get_expr(proargdefaults, 0) from pg_proc
    where proname = 'resume_connection_targets' and pronamespace = 'poster'::regnamespace),
  '60 minutes',
  'and no longer hard-codes the interval');

select doesnt_match(
  (select pg_get_expr(proargdefaults, 0) from pg_proc
    where proname = 'expire_paused_targets' and pronamespace = 'poster'::regnamespace),
  '60 minutes',
  'neither does the sweeper');

select * from finish();
rollback;
