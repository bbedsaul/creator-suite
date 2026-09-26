-- =============================================================================
-- Social Poster · migration 2 of 4 · credentials (vault), connections, consent, grants
-- Credentials are envelope-encrypted by the application: a per-row data key
-- encrypts the secret, and the data key is wrapped by the KMS. Neither the
-- plaintext secret nor the unwrapped key is ever stored here (NFR-03).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Credentials. With an aggregator adapter (v1) one credential — the user's
-- aggregator profile key — backs all of that user's connections. Direct
-- adapters later store one oauth_token credential per connection. (D-013)
-- ---------------------------------------------------------------------------
create table poster.credentials (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  kind        poster.credential_kind not null,
  provider    text not null,                 -- 'ayrshare' | 'upload_post' | 'tiktok' | ...
  ciphertext  bytea not null,
  wrapped_dek bytea not null,
  kms_key_id  text not null,
  nonce       bytea not null,
  expires_at  timestamptz,                   -- null for non-expiring aggregator profile keys
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, user_id)
);

create index credentials_expiring on poster.credentials (expires_at) where expires_at is not null;

create trigger credentials_touch before update on poster.credentials
  for each row execute function poster.touch_updated_at();

-- Every credential decrypt is logged (NFR-03). Survives credential deletion.
create table poster.vault_access_log (
  id            bigint generated always as identity primary key,
  credential_id uuid references poster.credentials (id) on delete set null,
  accessor      text not null,               -- 'dispatcher:tiktok', 'refresher', ...
  purpose       text not null,               -- 'dispatch', 'refresh', 'health_check'
  target_id     uuid,
  accessed_at   timestamptz not null default now()
);

create index vault_access_log_credential on poster.vault_access_log (credential_id, accessed_at desc);

-- ---------------------------------------------------------------------------
-- Connections: one per (user, platform, platform account). Owned by the user,
-- not by any app (contract §1).
-- ---------------------------------------------------------------------------
create table poster.connections (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users (id) on delete cascade,
  platform_id         text not null references poster.platforms (id),
  credential_id       uuid not null,
  external_account_id text not null,
  handle              text,
  display_name        text,
  avatar_url          text,
  status              poster.connection_status not null default 'active',
  status_reason       text,
  last_checked_at     timestamptz,
  refresh_failures    int not null default 0 check (refresh_failures >= 0),
  disconnected_at     timestamptz,           -- user removed it; row kept for post history
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  foreign key (credential_id, user_id) references poster.credentials (id, user_id),
  unique (id, user_id),
  unique (id, user_id, platform_id)          -- lets post_targets pin user AND platform in one FK
);

create unique index connections_one_live_per_account
  on poster.connections (user_id, platform_id, external_account_id)
  where disconnected_at is null;

create index connections_by_credential on poster.connections (credential_id);

create trigger connections_touch before update on poster.connections
  for each row execute function poster.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Scope requests & grants (contract §3). A grant is (app, user, connection, scopes).
-- ---------------------------------------------------------------------------
create table poster.scope_requests (
  id           uuid primary key default gen_random_uuid(),
  app_id       uuid not null references poster.client_apps (id),
  user_id      uuid not null references auth.users (id) on delete cascade,
  platforms    text[] not null check (cardinality(platforms) > 0),
  scopes       text[] not null check (cardinality(scopes) > 0),
  redirect_uri text not null,
  status       poster.scope_request_status not null default 'pending',
  expires_at   timestamptz not null default now() + interval '30 minutes',
  completed_at timestamptz,
  created_at   timestamptz not null default now()
);

create index scope_requests_pending on poster.scope_requests (expires_at) where status = 'pending';

create table poster.grants (
  id               uuid primary key default gen_random_uuid(),
  app_id           uuid not null references poster.client_apps (id),
  user_id          uuid not null,
  connection_id    uuid not null,
  scopes           text[] not null check (cardinality(scopes) > 0),
  scope_request_id uuid references poster.scope_requests (id),
  granted_at       timestamptz not null default now(),
  revoked_at       timestamptz,
  -- a grant can only cover a connection the same user owns
  foreign key (connection_id, user_id) references poster.connections (id, user_id) on delete cascade,
  check (revoked_at is null or revoked_at >= granted_at)
);

create unique index grants_one_live_per_app_connection
  on poster.grants (app_id, connection_id) where revoked_at is null;

create index grants_by_connection on poster.grants (connection_id) where revoked_at is null;
