-- =============================================================================
-- Poster · dispatch claim, fenced completion, retry, and reconciliation.
--
-- This is where NFR-02 (zero double-posts) actually lives. Rules under test:
--   * only a scheduled, due, un-suspended, connected target is claimable;
--   * a target in dispatching is NEVER re-claimed (CLAUDE.md rule 3);
--   * finish_dispatch is fenced on claimed_by, so a worker that lost its lease
--     cannot resolve the row;
--   * an ambiguous outcome fails loudly rather than risk a duplicate (D-012).
--
-- Every target below starts NOT due (due_at in the future) and each test makes
-- only its own target due before claiming. Otherwise one `claim_due_targets(…, 10)`
-- would sweep up rows a later test still needs.
-- =============================================================================
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(33);

\ir _fixtures/poster.psql

-- A third connection on its own platform, so the revoked / disconnected /
-- suspended cases cannot disturb the tiktok rows the other tests rely on.
insert into poster.connections (id, user_id, platform_id, credential_id, external_account_id)
values ('44444444-4444-4444-4444-444444444446','11111111-1111-1111-1111-111111111111',
        'x','33333333-3333-3333-3333-333333333333','x-a');

-- One post per scenario: post_targets is unique per (post, connection).
insert into poster.posts (id, user_id, app_id, content)
select ('55555555-5555-5555-5555-5555555555' || lpad(i::text, 2, '0'))::uuid,
       '11111111-1111-1111-1111-111111111111',
       '22222222-2222-2222-2222-222222222222',
       jsonb_build_object('text', 'post ' || i)
  from generate_series(1, 14) i;

insert into poster.post_targets (id, post_id, user_id, connection_id, platform_id, position, due_at, state)
select ('66666666-6666-6666-6666-6666666666' || lpad(i::text, 2, '0'))::uuid,
       ('55555555-5555-5555-5555-5555555555' || lpad(i::text, 2, '0'))::uuid,
       '11111111-1111-1111-1111-111111111111',
       '44444444-4444-4444-4444-444444444444',
       'tiktok', 0, now() + interval '1 day', 'scheduled'
  from generate_series(1, 14) i;

-- Targets on the isolated 'x' connection for the negative cases.
insert into poster.post_targets (id, post_id, user_id, connection_id, platform_id, position, due_at, state)
select ('66666666-6666-6666-6666-6666666fff' || lpad(i::text, 2, '0'))::uuid,
       ('55555555-5555-5555-5555-5555555555' || lpad(i::text, 2, '0'))::uuid,
       '11111111-1111-1111-1111-111111111111',
       '44444444-4444-4444-4444-444444444446',
       'x', 1, now() - interval '1 minute', 'scheduled'
  from generate_series(1, 3) i;

-- The in_flight attempt row a worker must write before calling any adapter
-- (CLAUDE.md rule 4).
create function pg_temp.begin_attempt(p_target uuid, p_worker text, p_no int) returns void
language sql as $$
  insert into poster.dispatch_attempts (target_id, attempt_no, worker_id, adapter)
  values (p_target, p_no, p_worker, 'fake');
$$;

-- Claims as setup rather than as an assertion: returns void so nothing lands
-- in the TAP stream.
create function pg_temp.claim(p_platform text, p_worker text) returns void
language plpgsql as $$ begin perform poster.claim_due_targets(p_platform, p_worker, 10); end $$;

create function pg_temp.make_due(p_target uuid) returns void
language sql as $$
  update poster.post_targets set due_at = now() - interval '1 minute' where id = p_target;
$$;

-- ---------------------------------------------------------------------------
-- What is claimable
-- ---------------------------------------------------------------------------
select pg_temp.make_due('66666666-6666-6666-6666-666666666601');
select is((select count(*)::int from poster.claim_due_targets('tiktok','w1',10)), 1,
  'claim_due_targets returns the one due scheduled target');

select results_eq(
  $$select state::text, claimed_by, attempt_count
      from poster.post_targets where id = '66666666-6666-6666-6666-666666666601'$$,
  $$values ('dispatching', 'w1', 1)$$,
  'the claim moves the row to dispatching, records the worker, and counts the attempt');

select isnt((select claim_expires_at from poster.post_targets
              where id = '66666666-6666-6666-6666-666666666601'), NULL,
  'the claim carries a lease expiry, so a crashed worker is detectable');

-- The single most important negative case in the schema.
select is((select count(*)::int from poster.claim_due_targets('tiktok','w2',10)), 0,
  'a target already dispatching is never handed to a second worker');

select is((select count(*)::int from poster.claim_due_targets('tiktok','w1',10)), 0,
  'a target scheduled for the future is not claimed early (NFR-01: never early)');

select pg_temp.make_due('66666666-6666-6666-6666-666666666603');
update poster.post_targets set next_attempt_at = now() + interval '10 minutes'
 where id = '66666666-6666-6666-6666-666666666603';
select is((select count(*)::int from poster.claim_due_targets('tiktok','w1',10)), 0,
  'a target inside its retry backoff is not claimed');

update poster.connections set status = 'revoked' where id = '44444444-4444-4444-4444-444444444446';
select is((select count(*)::int from poster.claim_due_targets('x','w1',10)), 0,
  'no target on a revoked connection is claimed');

update poster.connections set status = 'active' where id = '44444444-4444-4444-4444-444444444446';
update poster.post_targets set state = 'scheduled'
 where connection_id = '44444444-4444-4444-4444-444444444446' and state = 'paused';

update poster.connections set disconnected_at = now() where id = '44444444-4444-4444-4444-444444444446';
select is((select count(*)::int from poster.claim_due_targets('x','w1',10)), 0,
  'no target on a disconnected connection is claimed');
update poster.connections set disconnected_at = NULL where id = '44444444-4444-4444-4444-444444444446';

insert into poster.account_settings (user_id, posting_suspended_at, suspension_reason)
values ('11111111-1111-1111-1111-111111111111', now(), 'non-payment');
select is((select count(*)::int from poster.claim_due_targets('x','w1',10)), 0,
  'a suspended account dispatches nothing (FR-16)');
delete from poster.account_settings where user_id = '11111111-1111-1111-1111-111111111111';

-- Platform isolation (CLAUDE.md rule 10): one loop must not eat another's work.
select is((select count(*)::int from poster.claim_due_targets('tiktok','w1',50)
            where platform_id <> 'tiktok'), 0,
  'the tiktok loop claims only tiktok targets');

-- ---------------------------------------------------------------------------
-- Fencing: only the worker holding the claim may resolve the row
-- ---------------------------------------------------------------------------
select pg_temp.begin_attempt('66666666-6666-6666-6666-666666666601','w1',1);

select is(poster.finish_dispatch('66666666-6666-6666-6666-666666666601','not-the-holder',1,'success'),
  false,
  'finish_dispatch from the wrong worker returns false');

select results_eq(
  $$select state::text, claimed_by from poster.post_targets
      where id = '66666666-6666-6666-6666-666666666601'$$,
  $$values ('dispatching', 'w1')$$,
  'the fenced-out call changed no target state and left the claim intact');

select is((select outcome::text from poster.dispatch_attempts
            where target_id = '66666666-6666-6666-6666-666666666601' and attempt_no = 1),
  'in_flight',
  'the fenced-out call did not resolve the attempt row either');

select throws_ok(
  $$select poster.finish_dispatch('66666666-6666-6666-6666-666666666601','w1',1,'in_flight')$$,
  NULL, NULL,
  'finish_dispatch refuses in_flight: it exists to record a final outcome');

select is(poster.finish_dispatch('66666666-6666-6666-6666-666666666604','w1',1,'success'),
  false,
  'finish_dispatch on a target that was never claimed returns false');

-- ---------------------------------------------------------------------------
-- Outcomes
-- ---------------------------------------------------------------------------
select pg_temp.make_due('66666666-6666-6666-6666-666666666605');
select pg_temp.claim('tiktok','w1');
select pg_temp.begin_attempt('66666666-6666-6666-6666-666666666605','w1',1);
select ok(poster.finish_dispatch('66666666-6666-6666-6666-666666666605','w1',1,'success',
                                 'pp-5','https://example.test/p/5'),
  'a success is accepted from the claim holder');
select results_eq(
  $$select state::text, platform_post_id, permalink from poster.post_targets
      where id = '66666666-6666-6666-6666-666666666605'$$,
  $$values ('posted', 'pp-5', 'https://example.test/p/5')$$,
  'success posts the target and stores the permalink the webhook will carry');
select results_eq(
  $$select outcome::text, finished_at is not null from poster.dispatch_attempts
      where target_id = '66666666-6666-6666-6666-666666666605' and attempt_no = 1$$,
  $$values ('success', true)$$,
  'the attempt row is closed out with its outcome');

-- Transient, attempts remaining -> back to scheduled with backoff.
select pg_temp.make_due('66666666-6666-6666-6666-666666666606');
select pg_temp.claim('tiktok','w1');
select pg_temp.begin_attempt('66666666-6666-6666-6666-666666666606','w1',1);
select ok(poster.finish_dispatch('66666666-6666-6666-6666-666666666606','w1',1,'transient'),
  'a transient failure is accepted');
select is((select state::text from poster.post_targets where id = '66666666-6666-6666-6666-666666666606'),
  'scheduled',
  'a transient failure returns the target to scheduled for retry');
select ok((select next_attempt_at > now() from poster.post_targets
            where id = '66666666-6666-6666-6666-666666666606'),
  'the retry is pushed into the future by the backoff');
select is((select claimed_by from poster.post_targets where id = '66666666-6666-6666-6666-666666666606'),
  NULL,
  'the retry drops the claim so another worker may pick it up');

-- Transient with no attempts left -> failed/transient_exhausted.
update poster.post_targets set max_attempts = 1 where id = '66666666-6666-6666-6666-666666666607';
select pg_temp.make_due('66666666-6666-6666-6666-666666666607');
select pg_temp.claim('tiktok','w1');
select pg_temp.begin_attempt('66666666-6666-6666-6666-666666666607','w1',1);
select ok(poster.finish_dispatch('66666666-6666-6666-6666-666666666607','w1',1,'transient',
                                 NULL, NULL, 'upstream timed out'),
  'the last transient attempt is accepted');
select results_eq(
  $$select state::text, reason_class::text from poster.post_targets
      where id = '66666666-6666-6666-6666-666666666607'$$,
  $$values ('failed', 'transient_exhausted')$$,
  'exhausting the retries fails the target as transient_exhausted');

-- Permanent -> failed/platform_rejected, carrying the platform's own message.
select pg_temp.make_due('66666666-6666-6666-6666-666666666608');
select pg_temp.claim('tiktok','w1');
select pg_temp.begin_attempt('66666666-6666-6666-6666-666666666608','w1',1);
select ok(poster.finish_dispatch('66666666-6666-6666-6666-666666666608','w1',1,'permanent',
                                 NULL, NULL, 'caption too long'),
  'a permanent rejection is accepted');
select results_eq(
  $$select state::text, reason_class::text, platform_message from poster.post_targets
      where id = '66666666-6666-6666-6666-666666666608'$$,
  $$values ('failed', 'platform_rejected', 'caption too long')$$,
  'a permanent rejection fails the target and keeps the platform message');

-- ---------------------------------------------------------------------------
-- Ambiguity: unknown once holds for reconciliation, twice fails loudly (D-012)
-- ---------------------------------------------------------------------------
select pg_temp.make_due('66666666-6666-6666-6666-666666666609');
select pg_temp.claim('tiktok','w1');
select pg_temp.begin_attempt('66666666-6666-6666-6666-666666666609','w1',1);
select ok(poster.finish_dispatch('66666666-6666-6666-6666-666666666609','w1',1,'unknown'),
  'a first unknown outcome is accepted');
select results_eq(
  $$select state::text, needs_reconciliation from poster.post_targets
      where id = '66666666-6666-6666-6666-666666666609'$$,
  $$values ('dispatching', true)$$,
  'a first unknown holds the target in dispatching and flags it for reconciliation');

select ok(poster.finish_dispatch('66666666-6666-6666-6666-666666666609','w1',1,'unknown',
                                 NULL, NULL, 'lookup inconclusive'),
  'a second unknown is accepted');
select results_eq(
  $$select state::text, reason_class::text, needs_reconciliation
      from poster.post_targets where id = '66666666-6666-6666-6666-666666666609'$$,
  $$values ('failed', 'dispatch_outcome_unknown', false)$$,
  'a second unknown fails the target rather than risk a double-post');

-- ---------------------------------------------------------------------------
-- Stale lease detection feeds the reconciler
-- ---------------------------------------------------------------------------
select pg_temp.make_due('66666666-6666-6666-6666-666666666610');
select pg_temp.claim('tiktok','w1');
select pg_temp.make_due('66666666-6666-6666-6666-666666666611');
select pg_temp.claim('tiktok','w-live');

-- Only target 10's lease has expired.
update poster.post_targets set claim_expires_at = now() - interval '1 minute'
 where id = '66666666-6666-6666-6666-666666666610';

select results_eq(
  $$select id::text from poster.mark_stale_dispatches()$$,
  $$values ('66666666-6666-6666-6666-666666666610')$$,
  'mark_stale_dispatches flags only the target whose lease expired');

select is((select needs_reconciliation from poster.post_targets
            where id = '66666666-6666-6666-6666-666666666611'),
  false,
  'a live lease is left alone');

select is((select count(*)::int from poster.mark_stale_dispatches()), 0,
  'an already-flagged target is not flagged again, so the reconciler sees it once');

select * from finish();
rollback;
