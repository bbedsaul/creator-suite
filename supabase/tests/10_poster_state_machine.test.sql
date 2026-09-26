-- =============================================================================
-- Poster · target state machine, row constraints, and cross-tenant ownership.
--
-- These are the invariants CLAUDE.md rule 1 says must live in the database: app
-- code is not trusted to keep a target out of an illegal state, so every case
-- here is asserted against the constraint or trigger that rejects it.
-- =============================================================================
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(21);

\ir _fixtures/poster.psql

-- Extra posts: post_targets is unique per (post, connection), and user A has two
-- connections, so each post can carry at most two targets.
insert into poster.posts (id, user_id, app_id, content) values
  ('55555555-5555-5555-5555-555555555501','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','{"text":"p1"}'),
  ('55555555-5555-5555-5555-555555555502','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','{"text":"p2"}');

-- ---------------------------------------------------------------------------
-- Which states a target may be born in (D-016: accepted = awaiting renditions)
-- ---------------------------------------------------------------------------
select lives_ok(
  $$insert into poster.post_targets (id, post_id, user_id, connection_id, platform_id, position, due_at)
    values ('66666666-6666-6666-6666-66666666a001','55555555-5555-5555-5555-555555555555',
            '11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444444','tiktok',0, now())$$,
  'a target may be created in accepted');

select lives_ok(
  $$insert into poster.post_targets (id, post_id, user_id, connection_id, platform_id, position, due_at, state)
    values ('66666666-6666-6666-6666-66666666a002','55555555-5555-5555-5555-555555555555',
            '11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444445','youtube',1, now(),'scheduled')$$,
  'a target may be created in scheduled (no transcode needed)');

select throws_ok(
  $$insert into poster.post_targets (post_id, user_id, connection_id, platform_id, position, due_at, state, posted_at)
    values ('55555555-5555-5555-5555-555555555501','11111111-1111-1111-1111-111111111111',
            '44444444-4444-4444-4444-444444444444','tiktok',0, now(),'posted', now())$$,
  '23514', NULL,
  'a target cannot be created already posted');

select throws_ok(
  $$insert into poster.post_targets (post_id, user_id, connection_id, platform_id, position, due_at, state, claimed_by, claim_expires_at)
    values ('55555555-5555-5555-5555-555555555501','11111111-1111-1111-1111-111111111111',
            '44444444-4444-4444-4444-444444444444','tiktok',0, now(),'dispatching','w1', now() + interval '5 min')$$,
  '23514', NULL,
  'a target cannot be created already dispatching');

-- ---------------------------------------------------------------------------
-- Legal and illegal transitions
-- ---------------------------------------------------------------------------
select lives_ok(
  $$update poster.post_targets set state = 'scheduled'
     where id = '66666666-6666-6666-6666-66666666a001'$$,
  'accepted -> scheduled is legal (renditions ready)');

select throws_ok(
  $$update poster.post_targets set state = 'posted', posted_at = now()
     where id = '66666666-6666-6666-6666-66666666a001'$$,
  '23514', NULL,
  'scheduled -> posted is illegal: a post must be dispatched, not declared');

-- dispatching requires a claim, enforced by a row check independent of the trigger
select throws_ok(
  $$update poster.post_targets set state = 'dispatching'
     where id = '66666666-6666-6666-6666-66666666a001'$$,
  '23514', NULL,
  'scheduled -> dispatching without a claim is rejected');

select lives_ok(
  $$update poster.post_targets
       set state = 'dispatching', claimed_by = 'w1', claim_expires_at = now() + interval '5 minutes'
     where id = '66666666-6666-6666-6666-66666666a001'$$,
  'scheduled -> dispatching with a claim is legal');

select lives_ok(
  $$update poster.post_targets set state = 'posted', platform_post_id = 'pp-1'
     where id = '66666666-6666-6666-6666-66666666a001'$$,
  'dispatching -> posted is legal');

select isnt(
  (select posted_at from poster.post_targets where id = '66666666-6666-6666-6666-66666666a001'),
  NULL,
  'the trigger stamps posted_at so a posted row can never lack its timestamp');

select is(
  (select claimed_by from poster.post_targets where id = '66666666-6666-6666-6666-66666666a001'),
  NULL,
  'leaving dispatching drops the claim, so no lease outlives the flight');

-- The headline case from the session plan.
select throws_ok(
  $$update poster.post_targets set state = 'scheduled'
     where id = '66666666-6666-6666-6666-66666666a001'$$,
  '23514', NULL,
  'posted -> scheduled is illegal: a posted target is terminal');

select throws_ok(
  $$update poster.post_targets set state = 'canceled'
     where id = '66666666-6666-6666-6666-66666666a001'$$,
  '23514', NULL,
  'posted -> canceled is illegal, so history cannot be rewritten');

-- Cancel is allowed right up to dispatch, and refused after (contract §6).
select lives_ok(
  $$update poster.post_targets set state = 'canceled'
     where id = '66666666-6666-6666-6666-66666666a002'$$,
  'scheduled -> canceled is legal before dispatch begins');

-- ---------------------------------------------------------------------------
-- "failed requires a reason" in both directions
-- ---------------------------------------------------------------------------
insert into poster.post_targets (id, post_id, user_id, connection_id, platform_id, position, due_at, state)
values ('66666666-6666-6666-6666-66666666a003','55555555-5555-5555-5555-555555555501',
        '11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444444','tiktok',0, now(),'scheduled');

select throws_ok(
  $$update poster.post_targets set state = 'failed'
     where id = '66666666-6666-6666-6666-66666666a003'$$,
  '23514', NULL,
  'failed without a reason_class is rejected');

select throws_ok(
  $$update poster.post_targets set reason_class = 'platform_rejected'
     where id = '66666666-6666-6666-6666-66666666a003'$$,
  '23514', NULL,
  'a reason_class on a non-failed target is rejected');

select lives_ok(
  $$update poster.post_targets set state = 'failed', reason_class = 'grant_revoked'
     where id = '66666666-6666-6666-6666-66666666a003'$$,
  'failed with a reason_class is accepted');

select throws_ok(
  $$update poster.post_targets set needs_reconciliation = true
     where id = '66666666-6666-6666-6666-66666666a003'$$,
  '23514', NULL,
  'only a dispatching target can be flagged for reconciliation');

-- ---------------------------------------------------------------------------
-- Cross-tenant ownership: composite FKs, not application checks
-- ---------------------------------------------------------------------------
select throws_ok(
  $$insert into poster.post_targets (post_id, user_id, connection_id, platform_id, position, due_at)
    values ('55555555-5555-5555-5555-555555555502','11111111-1111-1111-1111-111111111111',
            '44444444-4444-4444-4444-4444bbbbbbbb','tiktok',0, now())$$,
  '23503', NULL,
  'a target on another user''s connection is rejected by the composite FK');

select throws_ok(
  $$insert into poster.post_targets (post_id, user_id, connection_id, platform_id, position, due_at)
    values ('55555555-5555-5555-5555-555555555502','11111111-1111-1111-1111-111111111111',
            '44444444-4444-4444-4444-444444444444','youtube',0, now())$$,
  '23503', NULL,
  'a target whose platform disagrees with its connection is rejected by the same FK');

-- Media ownership travels through the same pattern.
insert into poster.media (id, user_id, app_id, kind, status, storage_path, mime_type)
values ('88888888-8888-8888-8888-88888888888b','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '22222222-2222-2222-2222-222222222222','image','ready','b/img.jpg','image/jpeg');

select throws_ok(
  $$insert into poster.post_media (post_id, user_id, part, position, media_id)
    values ('55555555-5555-5555-5555-555555555502','11111111-1111-1111-1111-111111111111',
            0, 0, '88888888-8888-8888-8888-88888888888b')$$,
  '23503', NULL,
  'a post cannot attach another user''s media');

select * from finish();
rollback;
