-- Social Poster — M1 operational queries (§11 Success Metrics, D-097).
--
-- Every query is read-only and standalone: paste one into psql, Supabase Studio,
-- or a dashboard tile. They are deliberately plain SQL rather than views, so that
-- reading a number and reading how it is computed are the same act — an operator
-- deciding whether to wake someone up should not have to go find a definition.
--
--   psql "$DATABASE_URL" -f supabase/observability/poster-m1-metrics.sql
--
-- The two that matter most are first. Alert on 2 and 6; watch the rest.

-- ---------------------------------------------------------------------------
-- 1. Punctuality (NFR-01): p95 dispatch lag under 60 s, and none early.
-- ---------------------------------------------------------------------------
-- Lag is posted_at - due_at. Positive is late, negative is early, and early is
-- the more serious of the two: a post that goes out before its time cannot be
-- taken back, while a late one is only late.
select
  platform_id,
  count(*)                                                        as posted,
  round(percentile_cont(0.50) within group (order by lag_s)::numeric, 3) as p50_lag_s,
  round(percentile_cont(0.95) within group (order by lag_s)::numeric, 3) as p95_lag_s,
  round(max(lag_s)::numeric, 3)                                   as max_lag_s,
  count(*) filter (where lag_s > 60)                              as over_budget,
  count(*) filter (where lag_s < 0)                               as posted_early
from (
  select platform_id, extract(epoch from (posted_at - due_at)) as lag_s
    from poster.post_targets
   where state = 'posted'
     and posted_at >= now() - interval '24 hours'
) lags
group by platform_id
order by platform_id;

-- ---------------------------------------------------------------------------
-- 2. Double posts (NFR-02): must be zero. Alert on any row.
-- ---------------------------------------------------------------------------
-- A target with more than one successful dispatch attempt has been published
-- twice. This is the query the alert runs; it is tracked as an incident, not a
-- rate (§11), because one is already too many.
select
  a.target_id,
  t.platform_id,
  t.user_id,
  count(*)                       as successful_attempts,
  min(a.finished_at)             as first_success,
  max(a.finished_at)             as last_success,
  array_agg(a.id order by a.attempt_no) as attempt_ids
from poster.dispatch_attempts a
join poster.post_targets t on t.id = a.target_id
where a.outcome = 'success'
group by a.target_id, t.platform_id, t.user_id
having count(*) > 1
order by last_success desc;

-- ---------------------------------------------------------------------------
-- 3. Dispatch success rate per platform (§11), last 24 h.
-- ---------------------------------------------------------------------------
select
  platform_id,
  count(*)                                             as targets,
  count(*) filter (where state = 'posted')             as posted,
  count(*) filter (where state = 'failed')             as failed,
  count(*) filter (where state = 'dispatching')        as in_flight,
  count(*) filter (where state in ('scheduled', 'accepted')) as waiting,
  count(*) filter (where state = 'paused')             as paused,
  round(
    100.0 * count(*) filter (where state = 'posted')
      / nullif(count(*) filter (where state in ('posted', 'failed')), 0),
    2
  )                                                    as success_pct
from poster.post_targets
where created_at >= now() - interval '24 hours'
group by platform_id
order by platform_id;

-- ---------------------------------------------------------------------------
-- 4. Failure reasons, so a rise has a cause attached (§11).
-- ---------------------------------------------------------------------------
-- `dispatch_outcome_unknown` is the one to watch: §11 says it should trend to
-- ~0. Each one is a target the reconciler could not resolve, which means a human
-- has to look. A rising count usually means the adapter cannot prove absence —
-- see D-084 on why that differs by provider.
select
  platform_id,
  reason_class,
  count(*) as failures,
  max(updated_at) as most_recent
from poster.post_targets
where state = 'failed'
  and updated_at >= now() - interval '24 hours'
group by platform_id, reason_class
order by failures desc;

-- ---------------------------------------------------------------------------
-- 5. Ambiguous outcomes still open: targets flagged for reconciliation.
-- ---------------------------------------------------------------------------
-- Nothing should sit here for long. A row older than one dispatch lease plus one
-- reconciler interval means reconciliation itself is not running (D-075).
select
  t.id as target_id,
  t.platform_id,
  t.claimed_by,
  t.claim_expires_at,
  now() - t.claim_expires_at as overdue_by,
  t.attempt_count
from poster.post_targets t
where t.needs_reconciliation
order by t.claim_expires_at;

-- ---------------------------------------------------------------------------
-- 6. Webhook delivery health (contract §7). Alert on gave_up.
-- ---------------------------------------------------------------------------
-- `gave_up` means a consumer missed an event permanently: 24 hours of retries
-- expired. `unroutable` shows up here too (D-077) — an app with no webhook_url.
select
  count(*)                                             as events,
  count(*) filter (where delivered_at is not null)     as delivered,
  count(*) filter (where gave_up_at is not null)       as gave_up,
  count(*) filter (where delivered_at is null and gave_up_at is null) as pending,
  max(attempt_count)                                   as worst_attempt_count,
  round(
    avg(extract(epoch from (delivered_at - occurred_at)))::numeric, 3
  )                                                    as avg_delivery_s
from poster.webhook_events
where occurred_at >= now() - interval '24 hours';

-- Undelivered events with their last error, newest first.
select
  id, type, attempt_count, next_attempt_at, gave_up_at, last_error
from poster.webhook_events
where delivered_at is null
  and occurred_at >= now() - interval '24 hours'
order by occurred_at desc
limit 50;

-- ---------------------------------------------------------------------------
-- 7. Connection health (§11): revocations, and reconnects inside the window.
-- ---------------------------------------------------------------------------
select
  platform_id,
  count(*)                                              as connections,
  count(*) filter (where status = 'active')             as active,
  count(*) filter (where status = 'revoked')            as revoked,
  count(*) filter (where disconnected_at is not null)   as disconnected,
  round(
    100.0 * count(*) filter (where status = 'revoked') / nullif(count(*), 0), 2
  )                                                     as revoked_pct
from poster.connections
group by platform_id
order by platform_id;

-- ---------------------------------------------------------------------------
-- 8. Credential access trail (NFR-03): who read what, and why.
-- ---------------------------------------------------------------------------
-- Every decrypt writes a row (rule 5). A purpose or accessor that should not be
-- reading credentials shows up here and nowhere else.
select
  accessor,
  purpose,
  count(*)        as reads,
  max(accessed_at) as most_recent
from poster.vault_access_log
where accessed_at >= now() - interval '24 hours'
group by accessor, purpose
order by reads desc;
