-- =============================================================================
-- Poster · row level security and privileges (NFR-06, D-024).
--
-- The browser never reaches the database (D-024): frontends use Supabase for
-- sign-in only and all data goes through the service API as service_role. The
-- policies here are defence in depth, so what matters is that `authenticated`
--   * cannot read secrets or audit tables at all,
--   * sees only its own rows in the tables it can read,
--   * cannot write anything,
--   * cannot execute any dispatch function.
-- =============================================================================
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(23);

\ir _fixtures/poster.psql

-- Give both users a post target, a media row, an attempt, and an event so that
-- "sees nothing" is a real assertion rather than an empty table.
insert into poster.post_targets (id, post_id, user_id, connection_id, platform_id, position, due_at, state) values
  ('66666666-6666-6666-6666-6666666600a1','55555555-5555-5555-5555-555555555555',
   '11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444444','tiktok',0, now(),'scheduled'),
  ('66666666-6666-6666-6666-6666666600b1','55555555-5555-5555-5555-55555555555b',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','44444444-4444-4444-4444-4444bbbbbbbb','tiktok',0, now(),'scheduled');

insert into poster.media (id, user_id, app_id, kind, status, storage_path, mime_type) values
  ('88888888-8888-8888-8888-88888888a001','11111111-1111-1111-1111-111111111111',
   '22222222-2222-2222-2222-222222222222','image','ready','a/img.jpg','image/jpeg'),
  ('88888888-8888-8888-8888-88888888b001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '22222222-2222-2222-2222-222222222222','image','ready','b/img.jpg','image/jpeg');

insert into poster.dispatch_attempts (target_id, attempt_no, worker_id, adapter)
values ('66666666-6666-6666-6666-6666666600a1', 1, 'w1', 'fake');

insert into poster.vault_access_log (credential_id, accessor, purpose)
values ('33333333-3333-3333-3333-333333333333','dispatcher:tiktok','dispatch');

insert into poster.idempotency_keys (app_id, key, request_hash)
values ('22222222-2222-2222-2222-222222222222','idem-1','\x00');

insert into poster.scope_requests (app_id, user_id, platforms, scopes, redirect_uri)
values ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111',
        '{tiktok}','{publish}','https://app.test/cb');

-- Become user A.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select is(auth.uid(), '11111111-1111-1111-1111-111111111111'::uuid,
  'the test session is acting as user A');

-- ---------------------------------------------------------------------------
-- Tables a user must never read at all (RLS enabled, no policy, no grant)
-- ---------------------------------------------------------------------------
select throws_ok('select * from poster.credentials', '42501', NULL,
  'credentials are unreadable: tokens never leave the vault module (rule 5)');

select throws_ok('select * from poster.vault_access_log', '42501', NULL,
  'the vault access log is unreadable');

select throws_ok('select * from poster.dispatch_attempts', '42501', NULL,
  'dispatch attempts are unreadable: they hold raw platform responses');

select throws_ok('select * from poster.webhook_events', '42501', NULL,
  'the webhook outbox is unreadable');

select throws_ok('select * from poster.idempotency_keys', '42501', NULL,
  'idempotency keys are unreadable');

select throws_ok('select * from poster.scope_requests', '42501', NULL,
  'scope requests are unreadable');

select throws_ok('select * from poster.client_apps', '42501', NULL,
  'client app rows, including secret hashes, are unreadable');

-- ---------------------------------------------------------------------------
-- Tables a user may read, scoped to their own rows
-- ---------------------------------------------------------------------------
select is((select count(*)::int from poster.posts), 1,
  'user A sees only its own post, not user B''s');

select is((select user_id from poster.posts), '11111111-1111-1111-1111-111111111111'::uuid,
  'and the row it sees is its own');

select is((select count(*)::int from poster.post_targets), 1,
  'user A sees only its own target');

select is((select count(*)::int from poster.connections), 2,
  'user A sees its own two connections and neither of user B''s');

select is((select count(*)::int from poster.media), 1,
  'user A sees only its own media');

select is((select count(*)::int from poster.post_status), 1,
  'the derived post_status view is scoped by the invoker''s RLS (security_invoker)');

select is((select count(*)::int from poster.platforms), 6,
  'platform reference data is readable by any signed-in user');

select is((select count(*)::int from poster.target_transitions), 13,
  'the legal transition table is readable, so a client can render the lifecycle');

-- ---------------------------------------------------------------------------
-- Writes are the service API's job, never the browser's (D-024)
-- ---------------------------------------------------------------------------
select throws_ok(
  $$insert into poster.posts (user_id, app_id, content)
    values ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','{"text":"x"}')$$,
  '42501', NULL,
  'a user cannot insert a post directly');

select throws_ok(
  $$update poster.posts set content = '{"text":"tampered"}'$$,
  '42501', NULL,
  'a user cannot update its own post directly');

select throws_ok(
  $$update poster.post_targets set state = 'posted'$$,
  '42501', NULL,
  'a user cannot move a target''s state directly (rule 2)');

select throws_ok('delete from poster.connections', '42501', NULL,
  'a user cannot delete a connection directly');

-- ---------------------------------------------------------------------------
-- Dispatch functions are service_role-only
-- ---------------------------------------------------------------------------
select throws_ok(
  $$select poster.claim_due_targets('tiktok','attacker')$$, '42501', NULL,
  'a user cannot claim dispatch work');

select throws_ok(
  $$select poster.finish_dispatch('66666666-6666-6666-6666-6666666600a1','attacker',1,'success')$$,
  '42501', NULL,
  'a user cannot resolve a dispatch');

-- ---------------------------------------------------------------------------
-- A disconnected connection drops out of the user's view
-- ---------------------------------------------------------------------------
reset role;
update poster.connections set disconnected_at = now()
 where id = '44444444-4444-4444-4444-444444444445';
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select is((select count(*)::int from poster.connections), 1,
  'a disconnected connection is hidden, while its posts stay in history');

reset role;
select * from finish();
rollback;
