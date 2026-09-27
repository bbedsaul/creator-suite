-- =============================================================================
-- Poster · the launch switch actually switches (D-070).
--
-- `platforms.enabled` is how OQ-2 controls which platforms are live. Before this
-- migration nothing read it, so a "disabled" platform kept dispatching. These
-- assertions are about the claim refusing work, which is the only place that can
-- be enforced for every worker at once.
-- =============================================================================
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(6);

\ir _fixtures/poster.psql

insert into poster.posts (id, user_id, app_id, content) values
  ('55555555-5555-5555-5555-5555555555e1','11111111-1111-1111-1111-111111111111',
   '22222222-2222-2222-2222-222222222222','{"text":"x"}'),
  ('55555555-5555-5555-5555-5555555555e2','11111111-1111-1111-1111-111111111111',
   '22222222-2222-2222-2222-222222222222','{"text":"y"}');

insert into poster.post_targets (id, post_id, user_id, connection_id, platform_id, position, due_at, state) values
  ('66666666-6666-6666-6666-6666666666e1','55555555-5555-5555-5555-5555555555e1',
   '11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444444','tiktok',0,
   now() - interval '1 minute','scheduled');

-- Baseline: the fixture enabled tiktok, so the target is claimable.
select is((select count(*)::int from poster.claim_due_targets('tiktok','w1',10)), 1,
  'an enabled platform with a spec dispatches');

-- Put it back for the next assertion.
update poster.post_targets set state = 'scheduled', claimed_by = null, claim_expires_at = null
 where id = '66666666-6666-6666-6666-6666666666e1';

update poster.platforms set enabled = false where id = 'tiktok';
select is((select count(*)::int from poster.claim_due_targets('tiktok','w1',10)), 0,
  'disabling a platform stops the claim immediately, without restarting a worker');

select is((select state::text from poster.post_targets where id = '66666666-6666-6666-6666-6666666666e1'),
  'scheduled',
  'and the target is left alone rather than failed');

update poster.platforms set enabled = true where id = 'tiktok';
select is((select count(*)::int from poster.claim_due_targets('tiktok','w1',10)), 1,
  're-enabling it resumes dispatch');

-- A platform with no constraint spec cannot be validated against (D-058), so it
-- must not be dispatched to either.
update poster.post_targets set state = 'scheduled', claimed_by = null, claim_expires_at = null
 where id = '66666666-6666-6666-6666-6666666666e1';
delete from poster.platform_constraints where platform_id = 'tiktok';

select is((select count(*)::int from poster.claim_due_targets('tiktok','w1',10)), 0,
  'a platform with no published constraint spec is not dispatched to');

-- The real property: nothing switches a platform on by accident. The fixture
-- enabled exactly tiktok, youtube and x; the rest are still dark.
select is(
  (select count(*)::int from poster.platforms where not enabled),
  3,
  'platforms ship disabled, and only an explicit switch makes one live (OQ-2)');

select * from finish();
rollback;
