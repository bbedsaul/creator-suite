-- =============================================================================
-- Social Poster · migration 1 of 4 · schema, enums, reference data, client apps
-- All Poster objects live in the `poster` schema. All writes go through the
-- Poster API / workers (service_role). The authenticated role gets read-only,
-- RLS-scoped access (see migration 4). See DECISIONS.md D-010..D-016.
-- =============================================================================

create schema if not exists poster;
revoke all on schema poster from public, anon;
grant usage on schema poster to authenticated, service_role;

-- Functions are private by default; migration 4 grants execute to service_role.
alter default privileges in schema poster revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type poster.connection_status    as enum ('active', 'expiring', 'revoked');
create type poster.credential_kind      as enum ('aggregator_profile', 'oauth_token');
create type poster.target_state         as enum ('accepted', 'scheduled', 'dispatching',
                                                 'posted', 'failed', 'paused', 'canceled');
-- First three are in the v1 contract; the rest are additive (contract §10) — see D-015.
create type poster.reason_class         as enum ('transient_exhausted', 'platform_rejected',
                                                 'token_revoked_expired', 'grant_revoked',
                                                 'rendition_failed', 'dispatch_outcome_unknown');
create type poster.attempt_outcome      as enum ('in_flight', 'success', 'transient',
                                                 'permanent', 'unknown');
create type poster.media_kind           as enum ('image', 'video');
create type poster.media_status         as enum ('pending_upload', 'ready', 'failed');
create type poster.rendition_status     as enum ('pending', 'ready', 'failed');
create type poster.scope_request_status as enum ('pending', 'completed', 'denied', 'expired');

-- ---------------------------------------------------------------------------
-- Shared trigger: updated_at
-- ---------------------------------------------------------------------------
create function poster.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Platforms (reference data)
-- ---------------------------------------------------------------------------
create table poster.platforms (
  id               text primary key check (id ~ '^[a-z_]+$'),
  display_name     text not null,
  supports_threads boolean not null default false,
  enabled          boolean not null default false,   -- flipped on per launch platform (OQ-2)
  created_at       timestamptz not null default now()
);

insert into poster.platforms (id, display_name, supports_threads) values
  ('x',              'X',              true),
  ('linkedin',       'LinkedIn',       false),
  ('instagram',      'Instagram',      false),
  ('tiktok',         'TikTok',         false),
  ('youtube',        'YouTube',        false),
  ('facebook_pages', 'Facebook Pages', false);

-- Constraint specs served by GET /v1/platforms/constraints (contract §10).
-- Intentionally unseeded: concrete limits depend on the aggregator (OQ-1) and
-- are loaded in session S04 as data, never hard-coded in application code.
create table poster.platform_constraints (
  platform_id  text primary key references poster.platforms (id),
  spec         jsonb not null,
  spec_version int not null default 1 check (spec_version > 0),
  updated_at   timestamptz not null default now()
);

create trigger platform_constraints_touch before update on poster.platform_constraints
  for each row execute function poster.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Client apps (API clients: poster-web composer, trainer, clipper, externals)
-- ---------------------------------------------------------------------------
create table poster.client_apps (
  id                 uuid primary key default gen_random_uuid(),
  client_id          text not null unique,
  name               text not null,
  client_secret_hash text not null,          -- argon2id; plaintext only in the secrets manager
  webhook_url        text,
  webhook_secret_ref text,                   -- secrets-manager reference, never the secret itself
  first_party        boolean not null default false,
  rate_limit_per_min int not null default 600 check (rate_limit_per_min > 0),
  disabled_at        timestamptz,
  created_at         timestamptz not null default now(),
  check ((webhook_url is null) = (webhook_secret_ref is null))
);
