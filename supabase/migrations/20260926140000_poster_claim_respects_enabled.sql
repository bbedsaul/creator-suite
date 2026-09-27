-- =============================================================================
-- Social Poster · claim_due_targets respects platforms.enabled
--
-- `platforms.enabled` is the launch switch for OQ-2, but until now nothing read
-- it: the column was decorative. The worker starts a loop per enabled platform,
-- which means disabling a platform only takes effect on the next restart, and a
-- worker already running would keep publishing to it.
--
-- Making the claim itself refuse a disabled platform turns the switch into an
-- actual switch: it takes effect immediately, for every worker, and it holds even
-- if a future caller forgets to check. Implements D-070.
--
-- Also joins platform_constraints: a platform with no published spec cannot be
-- validated against (D-058), so it must not be dispatched to either. The two
-- conditions are the same idea — being launched means being both switched on and
-- describable.
--
-- Bodies are otherwise unchanged from migration 4. Shipped as a new migration
-- because the bootstrap four are frozen (D-038).
-- =============================================================================

create or replace function poster.claim_due_targets(p_platform text,
                                                    p_worker   text,
                                                    p_limit    int      default 10,
                                                    p_lease    interval default interval '5 minutes')
returns setof poster.post_targets
language sql security definer set search_path = '' as $$
  with due as (
    select t.id
      from poster.post_targets t
      join poster.connections c            on c.id = t.connection_id
      join poster.platforms p              on p.id = t.platform_id
      join poster.platform_constraints pc  on pc.platform_id = p.id
      left join poster.account_settings s   on s.user_id = t.user_id
     where t.platform_id = p_platform
       and t.state = 'scheduled'
       and t.due_at <= now()
       and (t.next_attempt_at is null or t.next_attempt_at <= now())
       and c.status in ('active', 'expiring')
       and c.disconnected_at is null
       and s.posting_suspended_at is null
       and p.enabled
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

comment on function poster.claim_due_targets(text, text, int, interval) is
  'The only way a target enters dispatching. Refuses disabled platforms and '
  'platforms with no constraint spec, so the launch switch is effective immediately.';
