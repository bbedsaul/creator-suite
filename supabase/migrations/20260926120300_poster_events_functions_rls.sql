-- =============================================================================
-- Social Poster · migration 4 of 4 · webhook outbox, lifecycle triggers,
-- dispatch functions, derived post state, RLS and privileges
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Account-level switches (FR-16 suspension)
-- ---------------------------------------------------------------------------
create table poster.account_settings (
  user_id              uuid primary key references auth.users (id) on delete cascade,
  posting_suspended_at timestamptz,
  suspension_reason    text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check ((posting_suspended_at is null) = (suspension_reason is null))
);

create trigger account_settings_touch before update on poster.account_settings
  for each row execute function poster.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Webhook outbox (contract §7). Rows are written by triggers in the SAME
-- transaction as the state change, so an event can never be lost or invented.
-- `payload` holds { state?, data } with internal uuids; the delivery worker
-- builds the public envelope (prefixed ids, event_id, signature). (D-014)
-- ---------------------------------------------------------------------------
create table poster.webhook_events (
  id              uuid primary key default gen_random_uuid(),
  app_id          uuid not null references poster.client_apps (id),
  type            text not null,
  occurred_at     timestamptz not null default now(),
  post_id         uuid,
  target_id       uuid,
  external_ref    text,
  payload         jsonb not null,
  attempt_count   int not null default 0,
  next_attempt_at timestamptz not null default now(),
  delivered_at    timestamptz,
  gave_up_at      timestamptz,
  last_error      text,
  check (delivered_at is null or gave_up_at is null)
);

create index webhook_events_pending on poster.webhook_events (next_attempt_at)
  where delivered_at is null and gave_up_at is null;
create index webhook_events_by_post on poster.webhook_events (post_id) where post_id is not null;

-- Target state change -> post.* event for the owning app
create function poster.emit_target_event() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old  poster.target_state := case when tg_op = 'UPDATE' then old.state end;
  v_type text;
  v_data jsonb;
  v_app  uuid;
  v_ref  text;
begin
  if v_old is not distinct from new.state then return null; end if;

  v_type := case
    when new.state = 'scheduled' and v_old = 'paused'                  then 'post.resumed'
    when new.state = 'scheduled' and (v_old is null or v_old = 'accepted') then 'post.scheduled'
    when new.state = 'posted'                                          then 'post.posted'
    when new.state = 'failed'                                          then 'post.failed'
    when new.state = 'paused'                                          then 'post.paused'
    else null   -- dispatching, retry-to-scheduled, canceled: no event in v1
  end;
  if v_type is null then return null; end if;

  v_data := case v_type
    when 'post.scheduled' then jsonb_build_object('schedule_at', new.due_at)
    when 'post.posted'    then jsonb_build_object('permalink', new.permalink,
                                                  'platform_post_id', new.platform_post_id)
    when 'post.failed'    then jsonb_build_object('reason_class', new.reason_class,
                                                  'platform_message', new.platform_message)
    when 'post.paused'    then jsonb_build_object('connection_id', new.connection_id)
    else '{}'::jsonb
  end;

  select p.app_id, p.external_ref into v_app, v_ref from poster.posts p where p.id = new.post_id;

  insert into poster.webhook_events (app_id, type, post_id, target_id, external_ref, payload)
  values (v_app, v_type, new.post_id, new.id, v_ref,
          jsonb_build_object('state', new.state, 'data', v_data));
  return null;
end $$;

create trigger post_targets_emit after insert or update of state on poster.post_targets
  for each row execute function poster.emit_target_event();

-- ---------------------------------------------------------------------------
-- Pause / resume / expiry (contract §9)
-- ---------------------------------------------------------------------------
create function poster.pause_connection_targets(p_connection uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  update poster.post_targets set state = 'paused'
   where connection_id = p_connection and state = 'scheduled';
  get diagnostics n = row_count;
  return n;
end $$;

-- Grace window: 60 min proposed (contract §10 open item). Single source: this default.
create function poster.resume_connection_targets(p_connection uuid,
                                                 p_grace interval default interval '60 minutes')
returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  update poster.post_targets
     set state        = case when due_at >= now() - p_grace
                             then 'scheduled'::poster.target_state
                             else 'failed'::poster.target_state end,
         reason_class = case when due_at >= now() - p_grace
                             then null
                             else 'token_revoked_expired'::poster.reason_class end
   where connection_id = p_connection and state = 'paused';
  get diagnostics n = row_count;
  return n;
end $$;

-- Sweeper: paused targets whose grace ran out without a reconnect.
create function poster.expire_paused_targets(p_grace interval default interval '60 minutes')
returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  update poster.post_targets
     set state = 'failed', reason_class = 'token_revoked_expired'
   where state = 'paused' and due_at < now() - p_grace;
  get diagnostics n = row_count;
  return n;
end $$;

-- Connection health change -> pause/resume queue + connection.* events to granted apps
create function poster.on_connection_status_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_type text;
begin
  if new.status = old.status then return null; end if;

  if new.status = 'revoked' then
    perform poster.pause_connection_targets(new.id);
    v_type := 'connection.revoked';
  elsif old.status = 'revoked' then
    perform poster.resume_connection_targets(new.id);
    v_type := 'connection.restored';
  else
    return null;  -- active <-> expiring: visible via GET connections, no event in v1
  end if;

  insert into poster.webhook_events (app_id, type, payload)
  select g.app_id, v_type,
         jsonb_build_object('data', jsonb_build_object('connection_id', new.id,
                                                       'platform', new.platform_id))
    from poster.grants g
   where g.connection_id = new.id and g.revoked_at is null;
  return null;
end $$;

create trigger connections_status_change after update of status on poster.connections
  for each row execute function poster.on_connection_status_change();

-- Grant change -> grant.updated; revocation fails that app's undispatched targets
create function poster.on_grant_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into poster.webhook_events (app_id, type, payload)
  values (new.app_id, 'grant.updated',
          jsonb_build_object('data', jsonb_build_object(
            'grant_id', new.id, 'user_id', new.user_id, 'connection_id', new.connection_id,
            'scopes', to_jsonb(new.scopes), 'revoked', new.revoked_at is not null)));

  if tg_op = 'UPDATE' and old.revoked_at is null and new.revoked_at is not null then
    update poster.post_targets t
       set state = 'failed', reason_class = 'grant_revoked'
      from poster.posts p
     where p.id = t.post_id
       and p.app_id = new.app_id
       and t.connection_id = new.connection_id
       and t.state in ('accepted', 'scheduled', 'paused');
  end if;
  return null;
end $$;

create trigger grants_change after insert or update on poster.grants
  for each row execute function poster.on_grant_change();

-- ---------------------------------------------------------------------------
-- Dispatch: claim, finish, reconcile (NFR-02 — exactly-once lives here)
--
-- Invariant: only 'scheduled' rows are ever claimed. A row stuck in
-- 'dispatching' (worker died mid-call) is NEVER re-claimed; it is flagged for
-- reconciliation, which asks the platform what happened. An ambiguous outcome
-- fails loudly rather than risking a double-post. (D-012)
-- ---------------------------------------------------------------------------
create function poster.claim_due_targets(p_platform text,
                                         p_worker   text,
                                         p_limit    int      default 10,
                                         p_lease    interval default interval '5 minutes')
returns setof poster.post_targets
language sql security definer set search_path = '' as $$
  with due as (
    select t.id
      from poster.post_targets t
      join poster.connections c       on c.id = t.connection_id
      left join poster.account_settings s on s.user_id = t.user_id
     where t.platform_id = p_platform
       and t.state = 'scheduled'
       and t.due_at <= now()
       and (t.next_attempt_at is null or t.next_attempt_at <= now())
       and c.status in ('active', 'expiring')
       and c.disconnected_at is null
       and s.posting_suspended_at is null
     order by t.due_at
     limit p_limit
       for update of t skip locked
  )
  update poster.post_targets t
     set state            = 'dispatching',
         claimed_by       = p_worker,
         claim_expires_at = now() + p_lease,
         attempt_count    = t.attempt_count + 1
    from due
   where t.id = due.id
  returning t.*;
$$;

-- Fenced completion: succeeds only if this worker still holds the claim.
-- Returns false if fenced out (lease lost, already resolved) — caller must not retry.
create function poster.finish_dispatch(p_target           uuid,
                                       p_worker           text,
                                       p_attempt_no       int,
                                       p_outcome          poster.attempt_outcome,
                                       p_platform_post_id text        default null,
                                       p_permalink        text        default null,
                                       p_platform_message text        default null,
                                       p_response         jsonb       default null,
                                       p_http_status      int         default null,
                                       p_retry_at         timestamptz default null)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare v poster.post_targets%rowtype;
begin
  if p_outcome = 'in_flight' then
    raise exception 'finish_dispatch requires a final outcome';
  end if;

  select * into v from poster.post_targets
   where id = p_target and state = 'dispatching' and claimed_by = p_worker
     for update;
  if not found then return false; end if;

  update poster.dispatch_attempts
     set outcome = p_outcome, response = p_response, http_status = p_http_status,
         finished_at = now()
   where target_id = p_target and attempt_no = p_attempt_no;

  if p_outcome = 'success' then
    update poster.post_targets
       set state = 'posted', platform_post_id = p_platform_post_id, permalink = p_permalink
     where id = p_target;

  elsif p_outcome = 'transient' and v.attempt_count < v.max_attempts then
    update poster.post_targets
       set state = 'scheduled',
           next_attempt_at = coalesce(p_retry_at,
             now() + least(interval '30 minutes',
                           interval '30 seconds' * power(2, v.attempt_count - 1)))
     where id = p_target;

  elsif p_outcome = 'transient' then
    update poster.post_targets
       set state = 'failed', reason_class = 'transient_exhausted', platform_message = p_platform_message
     where id = p_target;

  elsif p_outcome = 'permanent' then
    update poster.post_targets
       set state = 'failed', reason_class = 'platform_rejected', platform_message = p_platform_message
     where id = p_target;

  elsif v.needs_reconciliation then   -- 'unknown' twice: reconciler couldn't tell either
    update poster.post_targets
       set state = 'failed', reason_class = 'dispatch_outcome_unknown',
           platform_message = p_platform_message
     where id = p_target;

  else                                 -- 'unknown' first time: hold for reconciliation
    update poster.post_targets set needs_reconciliation = true where id = p_target;
  end if;

  return true;
end $$;

-- Flags in-flight targets whose lease expired (worker crash). The reconciler
-- then resolves each via finish_dispatch(p_worker => claimed_by, ...).
create function poster.mark_stale_dispatches() returns setof poster.post_targets
language sql security definer set search_path = '' as $$
  update poster.post_targets
     set needs_reconciliation = true
   where state = 'dispatching'
     and claim_expires_at < now()
     and not needs_reconciliation
  returning *;
$$;

-- Webhook delivery claim: bumping next_attempt_at acts as the lease.
create function poster.claim_webhook_events(p_limit int default 50,
                                            p_lease interval default interval '1 minute')
returns setof poster.webhook_events
language sql security definer set search_path = '' as $$
  with due as (
    select e.id from poster.webhook_events e
     where e.delivered_at is null and e.gave_up_at is null and e.next_attempt_at <= now()
     order by e.next_attempt_at
     limit p_limit
       for update skip locked
  )
  update poster.webhook_events e
     set next_attempt_at = now() + p_lease, attempt_count = e.attempt_count + 1
    from due
   where e.id = due.id
  returning e.*;
$$;

-- ---------------------------------------------------------------------------
-- Derived logical-post state (contract §6)
-- ---------------------------------------------------------------------------
create view poster.post_status with (security_invoker = true) as
select p.id  as post_id,
       p.user_id,
       p.app_id,
       p.external_ref,
       count(*) as target_count,
       case
         when bool_and(t.state = 'posted')                              then 'posted'
         when bool_and(t.state = 'canceled')                            then 'canceled'
         when bool_and(t.state = 'failed')                              then 'failed'
         when bool_and(t.state in ('posted', 'failed', 'canceled'))     then 'partial'
         when bool_or(t.state = 'dispatching')                          then 'dispatching'
         when bool_or(t.state = 'paused')                               then 'paused'
         when bool_or(t.state = 'scheduled')                            then 'scheduled'
         else 'accepted'
       end as state
  from poster.posts p
  join poster.post_targets t on t.post_id = p.id
 group by p.id;

-- ---------------------------------------------------------------------------
-- RLS (NFR-06). authenticated = read-only on own rows. service_role bypasses RLS.
-- Tables with RLS enabled and no policy are service_role-only by construction.
-- ---------------------------------------------------------------------------
alter table poster.platforms            enable row level security;
alter table poster.platform_constraints enable row level security;
alter table poster.client_apps          enable row level security;
alter table poster.credentials          enable row level security;  -- no policy: never readable
alter table poster.vault_access_log     enable row level security;  -- no policy
alter table poster.connections          enable row level security;
alter table poster.scope_requests       enable row level security;  -- no policy
alter table poster.grants               enable row level security;
alter table poster.media                enable row level security;
alter table poster.media_renditions     enable row level security;
alter table poster.posts                enable row level security;
alter table poster.post_media           enable row level security;
alter table poster.target_transitions   enable row level security;
alter table poster.post_targets         enable row level security;
alter table poster.dispatch_attempts    enable row level security;  -- no policy (raw platform responses)
alter table poster.idempotency_keys     enable row level security;  -- no policy
alter table poster.account_settings     enable row level security;
alter table poster.webhook_events       enable row level security;  -- no policy

create policy platforms_read            on poster.platforms            for select to authenticated using (true);
create policy platform_constraints_read on poster.platform_constraints for select to authenticated using (true);
create policy target_transitions_read   on poster.target_transitions   for select to authenticated using (true);

create policy connections_own on poster.connections  for select to authenticated
  using (user_id = (select auth.uid()) and disconnected_at is null);
create policy grants_own      on poster.grants       for select to authenticated
  using (user_id = (select auth.uid()));
create policy media_own       on poster.media        for select to authenticated
  using (user_id = (select auth.uid()));
create policy renditions_own  on poster.media_renditions for select to authenticated
  using (exists (select 1 from poster.media m
                  where m.id = media_id and m.user_id = (select auth.uid())));
create policy posts_own       on poster.posts        for select to authenticated
  using (user_id = (select auth.uid()));
create policy post_media_own  on poster.post_media   for select to authenticated
  using (user_id = (select auth.uid()));
create policy targets_own     on poster.post_targets for select to authenticated
  using (user_id = (select auth.uid()));
create policy settings_own    on poster.account_settings for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on all tables in schema poster from anon, authenticated;

grant select on poster.platforms, poster.platform_constraints, poster.target_transitions,
                poster.connections, poster.grants, poster.media, poster.media_renditions,
                poster.posts, poster.post_media, poster.post_targets, poster.account_settings,
                poster.post_status
  to authenticated;

grant all on all tables    in schema poster to service_role;
grant all on all sequences in schema poster to service_role;

revoke execute on all functions in schema poster from public, anon, authenticated;
grant  execute on all functions in schema poster to service_role;
