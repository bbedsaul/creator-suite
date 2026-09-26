-- =============================================================================
-- Social Poster · migration 3 of 4 · media, posts, targets, dispatch audit, idempotency
-- State lives per target (contract §6). Legal transitions are data
-- (poster.target_transitions) and enforced by trigger, not application code.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Media: uploaded once (FR-07); per-platform renditions cached by spec hash.
-- ---------------------------------------------------------------------------
create table poster.media (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  app_id       uuid not null references poster.client_apps (id),
  kind         poster.media_kind not null,
  status       poster.media_status not null default 'pending_upload',
  storage_path text not null unique,
  mime_type    text not null,
  size_bytes   bigint check (size_bytes >= 0),
  sha256       bytea,
  duration_ms  int check (duration_ms >= 0),
  width        int check (width > 0),
  height       int check (height > 0),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, user_id),
  check (kind <> 'video' or status <> 'ready' or duration_ms is not null)
);

create trigger media_touch before update on poster.media
  for each row execute function poster.touch_updated_at();

create table poster.media_renditions (
  id           uuid primary key default gen_random_uuid(),
  media_id     uuid not null references poster.media (id) on delete cascade,
  platform_id  text not null references poster.platforms (id),
  spec_hash    text not null,               -- hash of the transcode spec; same spec => reuse
  status       poster.rendition_status not null default 'pending',
  storage_path text,
  error        text,
  created_at   timestamptz not null default now(),
  unique (media_id, spec_hash),
  check (status <> 'ready' or storage_path is not null)
);

-- ---------------------------------------------------------------------------
-- Posts (logical) and their media
-- ---------------------------------------------------------------------------
create table poster.posts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  app_id       uuid not null references poster.client_apps (id),
  external_ref text,                         -- client's own id, echoed on every webhook
  content      jsonb not null,               -- { text, title?, thread?[] } — media via post_media
  schedule_at  timestamptz,                  -- null = dispatch as soon as accepted
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, user_id)
);

create index posts_by_app_ref on poster.posts (app_id, external_ref) where external_ref is not null;
create index posts_by_user    on poster.posts (user_id, created_at desc);

create trigger posts_touch before update on poster.posts
  for each row execute function poster.touch_updated_at();

create table poster.post_media (
  post_id  uuid not null,
  user_id  uuid not null,
  part     smallint not null default 0 check (part >= 0),      -- thread part index (FR-08)
  position smallint not null check (position >= 0),
  media_id uuid not null,
  primary key (post_id, part, position),
  foreign key (post_id, user_id)  references poster.posts (id, user_id) on delete cascade,
  foreign key (media_id, user_id) references poster.media (id, user_id)  -- only your own media
);

-- ---------------------------------------------------------------------------
-- Target state machine (data)
-- ---------------------------------------------------------------------------
create table poster.target_transitions (
  from_state poster.target_state not null,
  to_state   poster.target_state not null,
  primary key (from_state, to_state)
);

insert into poster.target_transitions (from_state, to_state) values
  ('accepted',    'scheduled'),    -- renditions ready
  ('accepted',    'canceled'),
  ('accepted',    'failed'),       -- rendition_failed, grant_revoked
  ('scheduled',   'dispatching'),  -- claimed by a worker
  ('scheduled',   'paused'),       -- connection revoked
  ('scheduled',   'canceled'),
  ('scheduled',   'failed'),       -- grant_revoked
  ('dispatching', 'posted'),
  ('dispatching', 'failed'),
  ('dispatching', 'scheduled'),    -- transient retry
  ('paused',      'scheduled'),    -- reconnected within grace
  ('paused',      'failed'),       -- grace expired / grant revoked
  ('paused',      'canceled');     -- cancel allowed until dispatch begins

-- ---------------------------------------------------------------------------
-- Post targets: one per (post, connection). The unit of dispatch.
-- ---------------------------------------------------------------------------
create table poster.post_targets (
  id                   uuid primary key default gen_random_uuid(),
  post_id              uuid not null,
  user_id              uuid not null,
  connection_id        uuid not null,
  platform_id          text not null,
  position             smallint not null check (position >= 0),  -- contract target_index
  overrides            jsonb not null default '{}'::jsonb,
  state                poster.target_state not null default 'accepted',
  due_at               timestamptz not null,  -- coalesce(schedule_at, accept time)
  next_attempt_at      timestamptz,           -- retry backoff
  attempt_count        int not null default 0 check (attempt_count >= 0),
  max_attempts         int not null default 5 check (max_attempts > 0),
  claimed_by           text,
  claim_expires_at     timestamptz,
  needs_reconciliation boolean not null default false,
  platform_post_id     text,
  permalink            text,
  reason_class         poster.reason_class,
  platform_message     text,
  posted_at            timestamptz,
  paused_at            timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  foreign key (post_id, user_id) references poster.posts (id, user_id) on delete cascade,
  -- same user owns the post and the connection, and platform matches the connection
  foreign key (connection_id, user_id, platform_id)
    references poster.connections (id, user_id, platform_id),
  unique (post_id, position),
  unique (post_id, connection_id),
  check ((state = 'failed') = (reason_class is not null)),
  check (state <> 'posted' or posted_at is not null),
  check (state <> 'dispatching' or (claimed_by is not null and claim_expires_at is not null)),
  check (not needs_reconciliation or state = 'dispatching')
);

-- The dispatcher's hot path: per-platform due scan (NFR-04 isolation).
create index post_targets_due         on poster.post_targets (platform_id, due_at) where state = 'scheduled';
create index post_targets_in_flight   on poster.post_targets (claim_expires_at)    where state = 'dispatching';
create index post_targets_by_conn     on poster.post_targets (connection_id)
  where state in ('accepted', 'scheduled', 'paused');
create index post_targets_paused_due  on poster.post_targets (due_at)              where state = 'paused';

create function poster.guard_target_state() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.state not in ('accepted', 'scheduled') then
      raise exception 'post_target cannot be created in state %', new.state
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.state is distinct from old.state then
    if not exists (select 1 from poster.target_transitions t
                    where t.from_state = old.state and t.to_state = new.state) then
      raise exception 'illegal post_target transition % -> % (target %)', old.state, new.state, old.id
        using errcode = 'check_violation';
    end if;

    if old.state = 'dispatching' then           -- leaving flight: drop the claim
      new.claimed_by           := null;
      new.claim_expires_at     := null;
      new.needs_reconciliation := false;
    end if;
    if new.state = 'paused' then new.paused_at := now(); end if;
    if new.state = 'posted' and new.posted_at is null then new.posted_at := now(); end if;
  end if;

  new.updated_at := now();
  return new;
end $$;

create trigger post_targets_guard before insert or update on poster.post_targets
  for each row execute function poster.guard_target_state();

-- ---------------------------------------------------------------------------
-- Dispatch attempts: full request/response audit (NFR-05). The worker inserts
-- the 'in_flight' row BEFORE calling the adapter; attempt id doubles as the
-- aggregator-side idempotency/reference key where supported (D-012).
-- ---------------------------------------------------------------------------
create table poster.dispatch_attempts (
  id          uuid primary key default gen_random_uuid(),
  target_id   uuid not null references poster.post_targets (id) on delete cascade,
  attempt_no  int not null check (attempt_no > 0),
  worker_id   text not null,
  adapter     text not null,                 -- 'fake' | 'ayrshare' | 'upload_post' | 'direct:tiktok'
  outcome     poster.attempt_outcome not null default 'in_flight',
  request     jsonb,
  response    jsonb,
  http_status int,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  unique (target_id, attempt_no),
  check ((outcome = 'in_flight') = (finished_at is null))
);

-- ---------------------------------------------------------------------------
-- Idempotency keys (contract §5): scoped per app, retained >= 24h.
-- Insert the key row in the same transaction that creates the post; a
-- concurrent duplicate blocks on the PK, then reads the stored result.
-- ---------------------------------------------------------------------------
create table poster.idempotency_keys (
  app_id          uuid not null references poster.client_apps (id),
  key             text not null check (length(key) between 1 and 255),
  request_hash    bytea not null,            -- sha256 of canonical request body
  post_id         uuid references poster.posts (id) on delete set null,
  response_status smallint,
  response_body   jsonb,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '48 hours',
  primary key (app_id, key)
);

create index idempotency_keys_expiry on poster.idempotency_keys (expires_at);
