-- =============================================================================
-- Poster · webhook outbox, revoke/pause/resume, and the grace window.
--
-- Contract §9: a revoked connection PAUSES the queue rather than failing it,
-- because the user's fix (reconnect) should rescue the posts. Past the grace
-- window a stale post is worse than a failure the app can resubmit.
--
-- Every event asserted here is written by a trigger in the same transaction as
-- the state change (D-014, CLAUDE.md rule 6). No app code inserts events.
-- =============================================================================
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(26);

\ir _fixtures/poster.psql

insert into poster.posts (id, user_id, app_id, content)
select ('55555555-5555-5555-5555-5555555555' || lpad(i::text, 2, '0'))::uuid,
       '11111111-1111-1111-1111-111111111111',
       '22222222-2222-2222-2222-222222222222',
       jsonb_build_object('text', 'post ' || i)
  from generate_series(1, 6) i;

create function pg_temp.event_types() returns setof text
language sql as $$ select type from poster.webhook_events order by type; $$;

-- ---------------------------------------------------------------------------
-- Insert-time events
-- ---------------------------------------------------------------------------
insert into poster.post_targets (id, post_id, user_id, connection_id, platform_id, position, due_at, state)
values ('66666666-6666-6666-6666-666666660001','55555555-5555-5555-5555-555555555501',
        '11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444444','tiktok',0,
        now() + interval '2 hours','scheduled');

select results_eq('select * from pg_temp.event_types()', $$values ('post.scheduled')$$,
  'a target created scheduled emits exactly one post.scheduled');

select is(
  (select payload->'data'->>'schedule_at' is not null from poster.webhook_events limit 1),
  true,
  'post.scheduled carries the schedule time clients asked for');

delete from poster.webhook_events;

insert into poster.post_targets (id, post_id, user_id, connection_id, platform_id, position, due_at)
values ('66666666-6666-6666-6666-666666660002','55555555-5555-5555-5555-555555555501',
        '11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444445','youtube',1,
        now() + interval '2 hours');

select is((select count(*)::int from poster.webhook_events), 0,
  'a target created accepted emits nothing: clients may never observe accepted (D-016)');

-- ---------------------------------------------------------------------------
-- Revoke -> pause (contract §9 steps 1-2)
-- ---------------------------------------------------------------------------
update poster.connections set status = 'revoked', status_reason = 'refresh failed'
 where id = '44444444-4444-4444-4444-444444444444';

select is((select state::text from poster.post_targets where id = '66666666-6666-6666-6666-666666660001'),
  'paused',
  'revoking a connection pauses its scheduled targets rather than failing them');

select isnt((select paused_at from poster.post_targets where id = '66666666-6666-6666-6666-666666660001'),
  NULL,
  'the pause is timestamped');

select is((select state::text from poster.post_targets where id = '66666666-6666-6666-6666-666666660002'),
  'accepted',
  'an accepted target on another connection is untouched');

select results_eq('select * from pg_temp.event_types()',
  $$values ('connection.revoked'), ('post.paused')$$,
  'the revoke emits connection.revoked and one post.paused per paused target');

select is(
  (select app_id from poster.webhook_events where type = 'connection.revoked'),
  '22222222-2222-2222-2222-222222222222'::uuid,
  'connection.revoked goes to the app holding a live grant on that connection');

select is(
  (select payload->'data'->>'connection_id' from poster.webhook_events where type = 'post.paused'),
  '44444444-4444-4444-4444-444444444444',
  'post.paused names the connection that caused it');

-- An app with no grant hears nothing about this connection.
select is(
  (select count(*)::int from poster.webhook_events
    where app_id = '22222222-2222-2222-2222-222222222223'),
  0,
  'an app without a grant receives no connection events');

-- ---------------------------------------------------------------------------
-- Reconnect inside the grace window (contract §9 step 4)
-- ---------------------------------------------------------------------------
delete from poster.webhook_events;
update poster.connections set status = 'active', status_reason = NULL
 where id = '44444444-4444-4444-4444-444444444444';

select results_eq(
  $$select state::text, reason_class::text from poster.post_targets
      where id = '66666666-6666-6666-6666-666666660001'$$,
  $$values ('scheduled', NULL::text)$$,
  'reconnecting returns a still-future target to scheduled with no reason attached');

select results_eq('select * from pg_temp.event_types()',
  $$values ('connection.restored'), ('post.resumed')$$,
  'the reconnect emits connection.restored and post.resumed');

-- ---------------------------------------------------------------------------
-- Past the grace window (contract §9 step 5)
-- ---------------------------------------------------------------------------
delete from poster.webhook_events;
update poster.post_targets set due_at = now() - interval '3 hours'
 where id = '66666666-6666-6666-6666-666666660001';
update poster.connections set status = 'revoked'
 where id = '44444444-4444-4444-4444-444444444444';

select is((select state::text from poster.post_targets where id = '66666666-6666-6666-6666-666666660001'),
  'paused',
  'a past-due target still pauses first, so a fast reconnect can still save it');

select is(poster.resume_connection_targets('44444444-4444-4444-4444-444444444444'), 1,
  'resume_connection_targets reports how many targets it resolved');

select results_eq(
  $$select state::text, reason_class::text from poster.post_targets
      where id = '66666666-6666-6666-6666-666666660001'$$,
  $$values ('failed', 'token_revoked_expired')$$,
  'a target past the grace window fails as token_revoked_expired rather than posting stale');

select is((select count(*)::int from poster.webhook_events where type = 'post.failed'), 1,
  'the grace expiry emits post.failed');

select is(
  (select payload->'data'->>'reason_class' from poster.webhook_events where type = 'post.failed'),
  'token_revoked_expired',
  'post.failed carries the machine-readable reason the client switches on');

-- Within grace, the same call reschedules instead of failing.
-- A target cannot be born paused (the guard trigger refuses it), so reach the
-- state the way production does: created scheduled, then paused.
insert into poster.post_targets (id, post_id, user_id, connection_id, platform_id, position, due_at, state)
values ('66666666-6666-6666-6666-666666660003','55555555-5555-5555-5555-555555555502',
        '11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444444','tiktok',0,
        now() - interval '10 minutes','scheduled');
update poster.post_targets set state = 'paused' where id = '66666666-6666-6666-6666-666666660003';

select is(poster.resume_connection_targets('44444444-4444-4444-4444-444444444444',
                                           interval '60 minutes'), 1,
  'a target 10 minutes past due is inside the default 60 minute window');

select is((select state::text from poster.post_targets where id = '66666666-6666-6666-6666-666666660003'),
  'scheduled',
  'it is rescheduled to dispatch immediately, not failed');

-- ---------------------------------------------------------------------------
-- The sweeper for queues nobody reconnected
-- ---------------------------------------------------------------------------
insert into poster.post_targets (id, post_id, user_id, connection_id, platform_id, position, due_at, state)
values ('66666666-6666-6666-6666-666666660004','55555555-5555-5555-5555-555555555503',
        '11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444444','tiktok',0,
        now() - interval '5 hours','scheduled'),
       ('66666666-6666-6666-6666-666666660005','55555555-5555-5555-5555-555555555504',
        '11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444444','tiktok',0,
        now() - interval '5 minutes','scheduled');
update poster.post_targets set state = 'paused'
 where id in ('66666666-6666-6666-6666-666666660004','66666666-6666-6666-6666-666666660005');

select is(poster.expire_paused_targets(), 1,
  'expire_paused_targets fails only the queue whose grace ran out');

select results_eq(
  $$select state::text, reason_class::text from poster.post_targets
      where id = '66666666-6666-6666-6666-666666660004'$$,
  $$values ('failed', 'token_revoked_expired')$$,
  'the long-stale target is failed');

select is((select state::text from poster.post_targets where id = '66666666-6666-6666-6666-666666660005'),
  'paused',
  'the recently-due target is still waiting for a reconnect');

-- ---------------------------------------------------------------------------
-- Grant revocation fails that app's undispatched work (D-015 grant_revoked)
-- ---------------------------------------------------------------------------
delete from poster.webhook_events;
update poster.grants set revoked_at = now()
 where id = '77777777-7777-7777-7777-777777777771';

select results_eq(
  $$select state::text, reason_class::text from poster.post_targets
      where id = '66666666-6666-6666-6666-666666660003'$$,
  $$values ('failed', 'grant_revoked')$$,
  'revoking a grant fails that app''s undispatched targets on the connection');

select is((select count(*)::int from poster.webhook_events where type = 'grant.updated'), 1,
  'the grant change emits grant.updated');

select is(
  (select payload->'data'->>'revoked' from poster.webhook_events where type = 'grant.updated'),
  'true',
  'grant.updated says the grant was revoked');

-- ---------------------------------------------------------------------------
-- Derived logical-post state (contract §6)
-- ---------------------------------------------------------------------------
insert into poster.post_targets (id, post_id, user_id, connection_id, platform_id, position, due_at, state, posted_at)
values ('66666666-6666-6666-6666-666666660006','55555555-5555-5555-5555-555555555505',
        '11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444444','tiktok',0,
        now(),'scheduled', NULL);
update poster.post_targets set state = 'dispatching', claimed_by = 'w1',
       claim_expires_at = now() + interval '5 minutes'
 where id = '66666666-6666-6666-6666-666666660006';
update poster.post_targets set state = 'posted' where id = '66666666-6666-6666-6666-666666660006';

insert into poster.post_targets (id, post_id, user_id, connection_id, platform_id, position, due_at, state, reason_class)
values ('66666666-6666-6666-6666-666666660007','55555555-5555-5555-5555-555555555505',
        '11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444445','youtube',1,
        now(),'scheduled', NULL);
update poster.post_targets set state = 'failed', reason_class = 'platform_rejected'
 where id = '66666666-6666-6666-6666-666666660007';

select is(
  (select state from poster.post_status where post_id = '55555555-5555-5555-5555-555555555505'),
  'partial',
  'a post with one posted and one failed target derives as partial, not posted');

select * from finish();
rollback;
