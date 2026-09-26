-- Harness smoke test: proves the pgTAP runner and the shared fixture both load.
--
-- pgtap is created inside this transaction and rolled back with it, so the
-- extension is never added to a migration or a deployed database (D-038).
-- The fixture lives outside supabase/tests/ because the runner executes every
-- *.sql under that directory as a test file.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(3);

select has_schema('poster', 'the poster schema exists');
select is(count(*)::int, 6, 'six platforms are seeded') from poster.platforms;

\ir _fixtures/poster.psql

select is(count(*)::int, 3, 'the fixture creates three connections')
  from poster.connections;

select * from finish();
rollback;
